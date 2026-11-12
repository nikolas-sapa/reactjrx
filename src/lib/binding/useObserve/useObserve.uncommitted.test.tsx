import { act, render } from "@testing-library/react"
import {
  Activity,
  Component,
  type ReactNode,
  Suspense,
  startTransition,
  use,
  useState,
} from "react"
import { BehaviorSubject } from "rxjs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { countSubscriptions } from "../../../tests/liveQuery"
import { ObservableStore } from "./store"
import { useObserve } from "./useObserve"

/**
 * The time a store keeps the subscription of a render that React does not
 * subscribe to. mobx-react-lite waits as long for the same reason.
 */
const UNCOMMITTED_RENDER_HOLD_MS = 10_000

const createPendingPromise = () => {
  let resolve = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

class CatchError extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    return this.state.hasError ? null : this.props.children
  }
}

describe("Given a render that React commits", () => {
  it("holds one subscription to the source while mounted, and none once unmounted", () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )

    function Observer() {
      "use no memo"
      const { data } = useObserve(counted$)

      return <>{data}</>
    }

    const { unmount, container } = render(<Observer />)

    expect(container.textContent).toBe("1")
    expect(subscriptions.open).toBe(1)

    unmount()

    expect(subscriptions.open).toBe(0)
  })

  it("holds one subscription to the new source once the deps change", () => {
    const first = countSubscriptions(new BehaviorSubject(1))
    const second = countSubscriptions(new BehaviorSubject(2))

    function Observer({ source }: { source: "first" | "second" }) {
      "use no memo"
      const { data } = useObserve(
        () => (source === "first" ? first.counted$ : second.counted$),
        [source],
      )

      return <>{data}</>
    }

    const { rerender, container } = render(<Observer source="first" />)

    rerender(<Observer source="second" />)

    expect(container.textContent).toBe("2")
    expect([first.subscriptions.open, second.subscriptions.open]).toEqual([
      0, 1,
    ])
  })
})

describe("Given a render that React throws away", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const releaseUncommittedRenders = () =>
    act(async () => {
      vi.advanceTimersByTime(UNCOMMITTED_RENDER_HOLD_MS)
    })

  it("releases the subscription of a mount that a Suspense boundary threw away", async () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )
    const { promise, resolve } = createPendingPromise()

    function Suspends() {
      "use no memo"
      use(promise)

      return null
    }

    function Observer() {
      "use no memo"
      useObserve(counted$)

      return null
    }

    const { unmount } = await act(async () =>
      render(
        <Suspense fallback={null}>
          <Observer />
          <Suspends />
        </Suspense>,
      ),
    )

    await act(async () => {
      resolve()
      await promise
    })
    unmount()
    await releaseUncommittedRenders()

    expect(subscriptions.open).toBe(0)
  })

  it("releases the subscription of a render that an error boundary caught", async () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})

    function Throws(): ReactNode {
      "use no memo"
      useObserve(counted$)

      throw new Error("render failed")
    }

    const { unmount } = render(
      <CatchError>
        <Throws />
      </CatchError>,
    )

    unmount()
    await releaseUncommittedRenders()

    expect(subscriptions.open).toBe(0)
  })

  it("releases the subscription of a render that a transition abandoned", async () => {
    const sources = [1, 2, 3].map((value) =>
      countSubscriptions(new BehaviorSubject(value)),
    )
    const pending = createPendingPromise()
    let setStep = (_step: number) => {}

    function Suspends({ step }: { step: number }) {
      "use no memo"
      if (step === 1) use(pending.promise)

      return null
    }

    function Observer() {
      "use no memo"
      const [step, setStepState] = useState(0)
      setStep = setStepState

      const { data } = useObserve(() => sources[step]?.counted$, [step])

      return (
        <>
          {data}
          <Suspends step={step} />
        </>
      )
    }

    const { unmount } = render(
      <Suspense fallback={null}>
        <Observer />
      </Suspense>,
    )

    await act(async () => {
      startTransition(() => setStep(1))
    })
    await act(async () => {
      setStep(2)
    })
    unmount()
    await releaseUncommittedRenders()

    expect(sources.map(({ subscriptions }) => subscriptions.open)).toEqual([
      0, 0, 0,
    ])
  })

  it("releases the subscription of a mount in a hidden Activity that unmounts", async () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )

    function Observer() {
      "use no memo"
      useObserve(counted$)

      return null
    }

    const { unmount } = await act(async () =>
      render(
        <Activity mode="hidden">
          <Observer />
        </Activity>,
      ),
    )

    unmount()
    await releaseUncommittedRenders()

    expect(subscriptions.open).toBe(0)
  })

  it("keeps a thrown away render's subscription until the hold ends", async () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )

    function Throws(): ReactNode {
      "use no memo"
      useObserve(counted$)

      throw new Error("render failed")
    }

    vi.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = render(
      <CatchError>
        <Throws />
      </CatchError>,
    )
    unmount()

    await act(async () => {
      vi.advanceTimersByTime(UNCOMMITTED_RENDER_HOLD_MS - 1)
    })

    expect(subscriptions.open).toBeGreaterThan(0)
  })
})

describe("Given a store that React subscribes to after its hold ended", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("subscribes to the source again, and keeps its values", () => {
    const subject = new BehaviorSubject(1)
    const { counted$, subscriptions } = countSubscriptions(subject)
    const store = new ObservableStore({
      source$: counted$,
      defaultValue: undefined,
      compareFn: undefined,
    })

    vi.advanceTimersByTime(UNCOMMITTED_RENDER_HOLD_MS)

    expect(subscriptions.open).toBe(0)
    expect(store.getSnapshot().data).toBe(1)

    const onChange = vi.fn()
    const unsubscribe = store.subscribe(onChange)
    subject.next(2)

    expect(subscriptions.open).toBe(1)
    expect(store.getSnapshot().data).toBe(2)
    expect(onChange).toHaveBeenCalled()

    unsubscribe()

    expect(subscriptions.open).toBe(0)
  })
})
