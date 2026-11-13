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
import { BehaviorSubject, of } from "rxjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { countSubscriptions } from "../../../tests/liveQuery"
import { useObserve } from "./useObserve"

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

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Given a render that React commits", () => {
  it("subscribes once to the source while mounted, and unsubscribes once unmounted", () => {
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
    expect(subscriptions).toEqual({ made: 1, open: 1 })

    unmount()

    expect(subscriptions.open).toBe(0)
  })

  it("subscribes to the new source once the deps change, and unsubscribes from the old one", () => {
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
    expect(first.subscriptions).toEqual({ made: 1, open: 0 })
    expect(second.subscriptions).toEqual({ made: 1, open: 1 })
  })

  it("renders the value of a BehaviorSubject on the first render, and renders once", () => {
    const statuses: string[] = []
    const source$ = new BehaviorSubject("value")

    function Observer() {
      "use no memo"
      const { data, status } = useObserve(source$)
      statuses.push(`${status}:${data}`)

      return null
    }

    render(<Observer />)

    expect(statuses).toEqual(["success:value"])
  })

  it("is pending on the first render for a source that holds no value, then has the value it emits on subscription", () => {
    const statuses: string[] = []
    const source$ = of("value")

    function Observer() {
      "use no memo"
      const { data, status } = useObserve(source$)
      statuses.push(`${status}:${data}`)

      return null
    }

    render(<Observer />)

    expect(statuses).toEqual(["pending:undefined", "success:value"])
  })
})

describe("Given a render that React throws away", () => {
  it("subscribes to nothing for a mount that a Suspense boundary threw away", async () => {
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

    expect(subscriptions.made).toBe(0)

    await act(async () => {
      resolve()
      await promise
    })

    expect(subscriptions).toEqual({ made: 1, open: 1 })

    unmount()

    expect(subscriptions.open).toBe(0)
  })

  it("subscribes to nothing for a render that an error boundary caught", () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})

    function Throws(): ReactNode {
      "use no memo"
      useObserve(counted$)

      throw new Error("render failed")
    }

    render(
      <CatchError>
        <Throws />
      </CatchError>,
    )

    expect(subscriptions.made).toBe(0)
  })

  it("subscribes to nothing for the render of a transition that React abandoned", async () => {
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

    const { unmount, container } = render(
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

    expect(container.textContent).toBe("3")
    expect(sources.map(({ subscriptions }) => subscriptions)).toEqual([
      { made: 1, open: 0 },
      { made: 0, open: 0 },
      { made: 1, open: 1 },
    ])

    unmount()
  })

  it("subscribes to nothing for a mount in a hidden Activity, until it shows", async () => {
    const { counted$, subscriptions } = countSubscriptions(
      new BehaviorSubject(1),
    )

    function Observer() {
      "use no memo"
      useObserve(counted$)

      return null
    }

    const App = ({ mode }: { mode: "visible" | "hidden" }) => (
      <Activity mode={mode}>
        <Observer />
      </Activity>
    )

    const { rerender, unmount } = await act(async () =>
      render(<App mode="hidden" />),
    )

    expect(subscriptions.made).toBe(0)

    await act(async () => {
      rerender(<App mode="visible" />)
    })

    expect(subscriptions).toEqual({ made: 1, open: 1 })

    unmount()

    expect(subscriptions.open).toBe(0)
  })
})

describe("Given a transition that suspends, then an unrelated urgent render", () => {
  it("keeps the committed subscription, and subscribes once to the source of the transition", async () => {
    const sources = [0, 1].map((value) =>
      countSubscriptions(new BehaviorSubject(value)),
    )
    const pending = createPendingPromise()
    let setStep = (_step: number) => {}
    let setUnrelated = (_value: number) => {}

    function Suspends({ step }: { step: number }) {
      "use no memo"
      if (step === 1) use(pending.promise)

      return null
    }

    function Observer() {
      "use no memo"
      const [step, setStepState] = useState(0)
      const [unrelated, setUnrelatedState] = useState(0)
      setStep = setStepState
      setUnrelated = setUnrelatedState

      const { data } = useObserve(() => sources[step]?.counted$, [step])

      return (
        <>
          {`${data}:${unrelated}`}
          <Suspends step={step} />
        </>
      )
    }

    const { container, unmount } = render(
      <Suspense fallback={null}>
        <Observer />
      </Suspense>,
    )

    await act(async () => {
      startTransition(() => setStep(1))
    })
    await act(async () => {
      setUnrelated(1)
    })

    expect(container.textContent).toBe("0:1")

    await act(async () => {
      pending.resolve()
      await pending.promise
    })

    expect(container.textContent).toBe("1:1")
    expect(sources.map(({ subscriptions }) => subscriptions)).toEqual([
      { made: 1, open: 0 },
      { made: 1, open: 1 },
    ])

    unmount()
  })
})
