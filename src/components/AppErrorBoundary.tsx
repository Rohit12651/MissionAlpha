import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-level error boundary. Wraps the whole tree so a render-time crash anywhere
 * (bad data shape, a three.js init blow-up that escapes the GlobeBoundary, etc.)
 * degrades to a calm "something broke" panel instead of a white screen. Offers a
 * reload affordance. The globe has its own inner boundary; this is the backstop.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary] uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <div
          className="rounded-panel border border-border bg-panel/80 px-6 py-7 backdrop-blur-sm"
          style={{ boxShadow: "0 0 0 1px var(--c-border), 0 0 32px -12px var(--c-stale-red)" }}
        >
          <h1 className="text-base font-semibold text-stale-red">Command tower hit a snag</h1>
          <p className="mt-2 text-sm text-muted">
            The dashboard stopped rendering. Your swarm is still running — this is only the view.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center rounded-full border border-border bg-panel-2 px-4 py-1.5 text-sm font-medium text-text outline-none transition-colors hover:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
