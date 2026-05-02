import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

type Props = {
  children: ReactNode;
  fallback?: (error: Error) => ReactNode;
};

type State =
  | { kind: 'ok' }
  | { kind: 'error'; error: Error };

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { kind: 'ok' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const err = error instanceof Error ? error : new Error(String(error));
    return { kind: 'error', error: err };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error', error, info);
  }

  render(): ReactNode {
    if (this.state.kind === 'error') {
      const { fallback } = this.props;
      if (fallback !== undefined) return fallback(this.state.error);
      return (
        <div role="alert" style={{ padding: '1rem', color: 'var(--color-danger, red)' }}>
          <strong>Something went wrong.</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
