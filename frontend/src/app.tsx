import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/features/auth/require-auth';
import { AssistantPage } from '@/routes/assistant-page';
import { ForgotPage } from '@/routes/forgot-page';
import { HomePage } from '@/routes/home-page';
import { LoginPage } from '@/routes/login-page';
import { RegisterPage } from '@/routes/register-page';
import { ResetPage } from '@/routes/reset-page';
import { SourcePage } from '@/routes/source-page';
import { SpacePage } from '@/routes/space-page';
import { NotesPage } from '@/routes/notes-page';
import { MembersPage } from '@/routes/members-page';
import { InvitePage } from '@/routes/invite-page';
import { SpaceActivityPage } from '@/routes/space-activity-page';

// ProseMirror stays off every other route's bundle.
const NotebookPage = lazy(() => import('@/routes/notebook-page').then((m) => ({ default: m.NotebookPage })));
const NotebookPrintPage = lazy(() =>
  import('@/routes/notebook-print-page').then((m) => ({ default: m.NotebookPrintPage })),
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/spaces/:id" element={<SpacePage />} />
        <Route path="/spaces/:spaceId/sources/:id" element={<SourcePage />} />
        <Route path="/spaces/:spaceId/notes" element={<NotesPage />} />
        <Route
          path="/spaces/:spaceId/notebook"
          element={
            <Suspense fallback={null}>
              <NotebookPage />
            </Suspense>
          }
        />
        <Route
          path="/spaces/:spaceId/notebook/print"
          element={
            <Suspense fallback={null}>
              <NotebookPrintPage />
            </Suspense>
          }
        />
        <Route path="/spaces/:spaceId/assistant" element={<AssistantPage />} />
        <Route path="/spaces/:spaceId/assistant/:conversationId" element={<AssistantPage />} />
        {/* Shared spaces v1 */}
        <Route path="/spaces/:spaceId/members" element={<MembersPage />} />
        <Route path="/spaces/:spaceId/activity" element={<SpaceActivityPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
