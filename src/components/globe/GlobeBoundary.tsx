import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Catches any error thrown inside the 3D Canvas subtree (lost WebGL context,
 * driver crash, three.js init failure) and swaps in a static fallback so the
 * rest of the dashboard keeps rendering. The globe is decorative — it must
 * never take the board down with it.
 */
export class GlobeBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Warn once; not user-facing. Keeps the failure observable in dev.
    console.warn("[PulseGlobe] 3D layer failed, using static fallback:", error.message, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
