import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/locale';

interface Props {
  children: ReactNode;
  text: ReturnType<typeof useUi>['text'];
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence: a throw during render would otherwise blank the whole
 * SPA, which is the failure mode `ApiError`'s readable messages exist to avoid.
 * Route-level states (`isPending`/`isError`) still handle expected failures —
 * this only catches the ones nobody planned for.
 */
class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The user gets a sentence; the detail belongs in the console (PRD §16).
    console.error('Unhandled error in render', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-md text-center">
          <Alert>
            {error instanceof ApiError
              ? error.message
              : this.props.text.authExtra.sessionFailed}
          </Alert>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            {this.props.text.common.tryAgain}
          </Button>
        </div>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { text } = useUi();
  return <ErrorBoundaryInner text={text}>{children}</ErrorBoundaryInner>;
}
