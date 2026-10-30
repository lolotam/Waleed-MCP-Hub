import { Component, type ReactNode } from 'react';
// A missing old-build lazy chunk must not turn the entire workspace white.
export class HelpBoundary extends Component<
  { children: ReactNode; close: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <section className="help-load-error" role="alert">
        <h2>Local guides could not load</h2>
        <p>
          The app may have been rebuilt. Refresh the page or restart the desktop
          manager, then open Help again. Your configuration has not changed.
        </p>
        <button onClick={this.props.close}>Close help notice</button>
      </section>
    ) : (
      this.props.children
    );
  }
}
