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
 * Long enough for a slow commit: React subscribing after the hold ended runs
 * the source a second time.
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
     * then has its value on the first render.
     *
     * This subscription only holds the shared source until React subscribes
     * in `subscribe`, which releases it, so the source runs once for both. A
     * render that never commits never subscribes: a timer releases the hold.
     * A render without `window` is taken as a server render, which never
     * commits: the hold ends once the synchronous values are read.
     *
     * An error is returned in the state, so it is handled here rather than
     * reported to RxJS as unhandled.
     */
    this.hold = this.source$.subscribe({ error: () => {} })

    if (isServer) {
      this.hold.unsubscribe()
    } else {
      const holdTimer = setTimeout(() => {
        this.hold.unsubscribe()
      }, UNCOMMITTED_RENDER_HOLD_MS)

      this.hold.add(() => clearTimeout(holdTimer))
    }
  }

  subscribe = (next: () => void) => {
    /**
     * The stream may already have completed or errored by the time React
     * subscribes. It won't emit again, and subscribing to the shared source
     * would only run it a second time.
     */
    const sub =
      this.state.observableState === "live"
        ? this.source$.subscribe({ complete: next, error: next, next })
        : Subscription.EMPTY

    // Released after React subscribes, so the shared source keeps running.
    this.hold.unsubscribe()

    return () => {
      sub.unsubscribe()
    }
  }

  getSnapshot = () => {
    return this.state
  }
}
