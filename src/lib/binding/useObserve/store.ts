import {
  BehaviorSubject,
  distinctUntilChanged,
  NEVER,
  type Observable,
  Subscription,
  share,
  tap,
} from "rxjs"
import { isServer } from "../../utils/isServer"

/**
 * How long a store keeps the subscription it opens during render while React
 * has not subscribed to it. React subscribes when the render commits. A
 * render that never commits (a Suspense boundary that suspends, an error
 * boundary, an abandoned transition) has nothing else to release it. Long
 * enough for a slow commit, as mobx-react-lite waits for its reactions.
 */
const UNCOMMITTED_RENDER_HOLD_MS = 10_000

export type State<T, DefaultValue, Error = unknown> = {
  data: T | DefaultValue
  status: "pending" | "success" | "error"
  observableState: "complete" | "error" | "live"
  error: Error | undefined
}

export interface ObservableStoreOptions<T, DefaultValue> {
  defaultValue: DefaultValue
  compareFn: ((a: T, b: T) => boolean) | undefined
}

export class ObservableStore<T, DefaultValue, Error = unknown> {
  state: State<T, DefaultValue, Error>
  source$: Observable<T | undefined>
  private hold: Subscription
  private holdTimer: ReturnType<typeof setTimeout> | undefined

  constructor({
    source$: miscSource$,
    defaultValue,
    compareFn,
  }: {
    source$: Observable<T> | undefined | (() => Observable<T> | undefined)
  } & ObservableStoreOptions<T, DefaultValue>) {
    const source$ =
      typeof miscSource$ === "function" ? miscSource$() : miscSource$

    const hasNoDefinedSource = source$ === undefined

    this.state = {
      data: source$ instanceof BehaviorSubject ? source$.value : defaultValue,
      status: hasNoDefinedSource ? "success" : "pending",
      observableState: hasNoDefinedSource ? "complete" : "live",
      error: undefined,
    }

    /**
     * There is nothing to observe without a source. The state above is already
     * final (`complete`), which makes `subscribe` a no-op and therefore makes
     * `source$` unreachable. We skip building the pipe chain and opening a
     * subscription for a stream that can never emit.
     */
    if (hasNoDefinedSource) {
      this.source$ = NEVER
      this.hold = Subscription.EMPTY

      return
    }

    this.source$ = source$.pipe(
      distinctUntilChanged(compareFn),
      tap({
        complete: () => {
          this.state = {
            ...this.state,
            status: "success",
            observableState: "complete",
          }
        },
        error: (error) => {
          this.state = {
            ...this.state,
            observableState: "error",
            status: "error",
            error,
          }
        },
        next: (data) => {
          this.state = { ...this.state, data }
        },
      }),
      share(),
    )

    /**
     * The store is created during render, and subscribes right away: a source
     * that emits synchronously (a `BehaviorSubject`, `of(x)`, a piped signal)
     * then has its value on the first render, and the source runs once for
     * the render and React's subscription together.
     *
     * This subscription only holds the shared source until React subscribes
     * in `subscribe`, which releases it. A render that never commits never
     * subscribes, so a timer releases the hold. A server render never
     * commits either, so it reads the synchronous values and releases the
     * hold at once.
     *
     * An error is returned in the state, so it is handled here rather than
     * reported to RxJS as unhandled.
     */
    this.hold = this.source$.subscribe({ error: () => {} })

    if (isServer) {
      this.releaseHold()
    } else if (!this.hold.closed) {
      this.holdTimer = setTimeout(this.releaseHold, UNCOMMITTED_RENDER_HOLD_MS)
    }
  }

  subscribe = (next: () => void) => {
    /**
     * The stream may already have completed or errored by the time React
     * subscribes. It won't emit again, and subscribing to the shared source
     * would only run it a second time.
     */
    if (this.state.observableState !== "live") {
      this.releaseHold()

      return () => {}
    }

    const sub = this.source$.subscribe({
      complete: next,
      error: next,
      next: next,
    })

    // Released after React subscribes, so the shared source keeps running.
    this.releaseHold()

    return () => {
      sub.unsubscribe()
    }
  }

  private releaseHold = () => {
    clearTimeout(this.holdTimer)
    this.hold.unsubscribe()
  }

  getSnapshot = () => {
    return this.state
  }
}
