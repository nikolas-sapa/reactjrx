// @vitest-environment node
import { renderToString } from "react-dom/server"
import { BehaviorSubject, concat, NEVER, of } from "rxjs"
import { describe, expect, it } from "vitest"
import { countSubscriptions } from "../../../tests/liveQuery"
import { useObserve } from "./useObserve"

describe("Given a server render", () => {
  it("renders the value of a BehaviorSubject, and leaves no subscription", () => {
    const subject = new BehaviorSubject(1)

    function Observer() {
      "use no memo"
      const { data } = useObserve(subject)

      return <>{data}</>
    }

    expect(renderToString(<Observer />)).toBe("1")
    expect(renderToString(<Observer />)).toBe("1")
    expect(subject.observed).toBe(false)
  })

  it("renders the value a live source emits synchronously, and leaves no subscription", () => {
    const { counted$, subscriptions } = countSubscriptions(
      concat(of("first"), NEVER),
    )

    function Observer() {
      "use no memo"
      const { data } = useObserve(counted$)

      return <>{data}</>
    }

    expect(renderToString(<Observer />)).toBe("first")
    expect(subscriptions).toEqual({ made: 1, open: 0 })
  })
})
