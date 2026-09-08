import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type {
  Conversation,
  ConversationListItem,
  ConversationMessage,
  Note,
  Notebook,
  Source,
  SourceBlock,
  SourceDetail,
  Space,
} from '@/lib/api';
import { AssistantPage } from '@/routes/assistant-page';
import { HomePage } from '@/routes/home-page';
import { NotebookPage } from '@/routes/notebook-page';
import { NotesPage } from '@/routes/notes-page';
import { SourcePage } from '@/routes/source-page';
import { SpacePage } from '@/routes/space-page';
import { MembersPage } from '@/routes/members-page';
import { InvitePage } from '@/routes/invite-page';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

/**
 * PRD §18 — axe-core over every primary screen, rendered the way the route
 * tests render them (real `api.ts`, `fetch` stubbed).
 *
 * jsdom has no layout, so axe cannot judge contrast here; that is checked by
 * hand against DESIGN.md (design "axe in the unit suite, humans for the rest").
 * Every other wcag2a/wcag2aa rule runs, plus axe's `best-practice` set — that is
 * where the landmark and heading-order rules live, and those found the real
 * findings (a nested `<main>`, rail content outside any landmark, h1 → h3).
 * Nothing is disabled: there is no jsdom false positive to suppress in this set.
 */
const RUN_ONLY: NonNullable<Parameters<typeof axe>[1]> = {
  runOnly: ['wcag2a', 'wcag2aa', 'best-practice'],
};

const user = { id: 'u1', name: 'Test Person', email: 'test@example.test' };

const space: Space = {
  id: 'space-1',
  name: 'Sleep and memory',
  objective: 'How does sleep consolidate memory?',
  audienceInstruction: null,
  audienceInstructionMaxChars: 300,
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  sourceCount: 3,
  noteCount: 2,
  myRole: 'owner',
  ownerName: 'Test Person',
  memberCount: 1,
};

const sourceBase: Source = {
  id: 'src-1',
  spaceId: 'space-1',
  type: 'pdf',
  title: 'Synaptic Homeostasis Hypothesis',
  author: 'Tononi',
  url: null,
  state: 'ready',
  errorMessage: null,
  archivedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

/** Every source state at once, so every badge and announcer renders. */
const sources: Source[] = [
  sourceBase,
  { ...sourceBase, id: 'src-2', type: 'web', title: 'Sleep Review 2024', url: 'https://example.test/sleep', state: 'processing' },
  {
    ...sourceBase,
    id: 'src-3',
    type: 'manual',
    title: 'Pasted abstract',
    state: 'failed',
    errorMessage: 'This text could not be processed.',
  },
  { ...sourceBase, id: 'src-4', title: 'An archived paper', archivedAt: '2026-08-10T10:00:00.000Z' },
];

const detail: SourceDetail = { ...sourceBase, blockCount: 4, pageCount: 2 };

const blocks: SourceBlock[] = [
  { ord: 1, text: 'Results', page: 1, paragraphIndex: null, heading: 'Results' },
  { ord: 2, text: 'SWS downscales synaptic weights across neocortex.', page: 1, paragraphIndex: null, heading: 'Results' },
];

const notes: Note[] = [
  {
    id: 'note-1',
    spaceId: 'space-1',
    title: 'Slow-wave sleep effects on synaptic plasticity',
    contentRich: {
      type: 'doc',
      question: 'How does slow-wave sleep affect plasticity?',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SWS downscales synaptic weights.' }] }],
    },
    originType: 'saved_answer',
    originConversationId: 'conv-1',
    originMessageId: 'msg-2',
    citationCount: 2,
    citations: [
      {
        id: 'cite-1',
        sourceId: 'src-1',
        sourceTitle: 'Synaptic Homeostasis Hypothesis',
        quotedText: 'SWS downscales synaptic weights across neocortex.',
        page: 12,
        paragraphRef: null,
        sectionHeading: 'Results',
        stale: false,
        createdAt: '2026-08-01T11:00:00.000Z',
      },
      {
        id: 'cite-2',
        sourceId: 'src-gone',
        sourceTitle: 'A deleted source',
        quotedText: 'gone',
        page: null,
        paragraphRef: 'p3',
        sectionHeading: null,
        stale: true,
        createdAt: '2026-08-01T11:00:00.000Z',
      },
    ],
    convertedSource: null,
    createdAt: '2026-08-01T11:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
  },
  {
    id: 'note-2',
    spaceId: 'space-1',
    title: 'Methodology considerations for EEG trials',
    contentRich: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check impedance every 2 hours.' }] }],
    },
    originType: 'user',
    originConversationId: null,
    originMessageId: null,
    citationCount: 0,
    citations: [],
    convertedSource: { id: 'src-3', state: 'failed' } as Note['convertedSource'],
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
  },
];

const conversation: Conversation = {
  id: 'conv-1',
  spaceId: 'space-1',
  title: 'Sleep and recall',
  scopeType: 'space',
  scopeSourceId: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

const conversationList: ConversationListItem[] = [
  { ...conversation, preview: 'What happens to recall after a short night?', messageCount: 2 },
];

const messages: ConversationMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'What happens to recall after a short night?',
    feedback: null,
    grounded: null,
    passagesSent: null,
    sourcesUsed: [],
    citations: [],
    savedNoteId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Recall drops after a short night [1].',
    feedback: 'useful',
    grounded: true,
    passagesSent: 6,
    sourcesUsed: [{ id: 'src-1', title: 'Synaptic Homeostasis Hypothesis' }],
    citations: [
      {
        id: 'mc-1',
        index: 1,
        sourceId: 'src-1',
        sourceTitle: 'Synaptic Homeostasis Hypothesis',
        quotedText: 'SWS downscales synaptic weights across neocortex.',
        reference: 'p. 12',
        stale: false,
      },
    ],
    savedNoteId: null,
    createdAt: '2026-08-20T10:00:05.000Z',
  },
];

const notebook: Notebook = {
  id: 'nb-1',
  spaceId: 'space-1',
  contentRich: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Draft title' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Sleep helps ' },
          {
            type: 'citation',
            attrs: { citationId: 'cite-1', sourceId: 'src-1', sourceTitle: 'Synaptic Homeostasis Hypothesis', page: 12, paragraphRef: null, quotedText: 'q' },
          },
        ],
      },
    ],
  },
  createdAt: '2026-08-27T09:00:00.000Z',
  updatedAt: '2026-08-27T09:00:00.000Z',
};

/** One handler for every screen: each route asks for a subset of these. */
function stubApi() {
  stubFetch((path, init) => {
    const url = new URL(path, 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/auth/me') return jsonResponse({ user });
    if (url.pathname === '/api/spaces' && method === 'GET') return jsonResponse({ spaces: [space] });
    if (url.pathname === '/api/activity') return jsonResponse({ items: [], nextCursor: null });
    if (url.pathname === '/api/spaces/space-1') return jsonResponse({ space });
    if (url.pathname === '/api/spaces/space-1/open') return jsonResponse({ space });
    if (url.pathname === '/api/spaces/space-1/sources') {
      return jsonResponse({
        sources: url.searchParams.get('archived') === 'only' ? sources.filter((s) => s.archivedAt) : sources.filter((s) => !s.archivedAt),
      });
    }
    if (url.pathname === '/api/sources/src-1') return jsonResponse({ source: detail });
    if (url.pathname === '/api/sources/src-1/blocks') return jsonResponse({ blocks });
    if (url.pathname === '/api/spaces/space-1/notes') return jsonResponse({ notes });
    if (url.pathname === '/api/notes/note-1') return jsonResponse({ note: notes[0] });
    if (url.pathname === '/api/spaces/space-1/conversations' && method === 'GET') {
      return jsonResponse({ conversations: conversationList });
    }
    if (url.pathname === '/api/conversations/conv-1') return jsonResponse({ conversation, messages });
    if (url.pathname === '/api/spaces/space-1/notebook') return jsonResponse({ notebook });
    if (url.pathname === '/api/spaces/space-1/notebook/presence') return jsonResponse({ users: [] });
    if (url.pathname === '/api/spaces/space-1/members') {
      return jsonResponse({
        members: [
          { userId: 'u1', name: 'Test Person', email: 'test@example.test', role: 'owner', joinedAt: '2026-08-01T10:00:00.000Z' },
          { userId: 'u2', name: 'Minh', email: 'minh@example.test', role: 'editor', joinedAt: '2026-08-02T10:00:00.000Z' },
        ],
        invites: [{ id: 'inv-1', email: 'an@example.test', role: 'viewer', expiresAt: '2026-09-04T10:00:00.000Z', createdAt: '2026-08-28T10:00:00.000Z' }],
      });
    }
    if (url.pathname === '/api/invites/tok-1') {
      return jsonResponse({
        invite: { spaceId: 'space-1', spaceName: 'Sleep and memory', role: 'editor', inviterName: 'Tan', expiresAt: '2026-09-04T10:00:00.000Z', alreadyMember: false },
      });
    }
    return jsonResponse({ error: { code: 'not_found', message: `unstubbed ${method} ${path}` } }, 404);
  });
}

function renderAt(path: string) {
  stubApi();
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/spaces/:id" element={<SpacePage />} />
      <Route path="/spaces/:spaceId/sources/:id" element={<SourcePage />} />
      <Route path="/spaces/:spaceId/notes" element={<NotesPage />} />
      <Route path="/spaces/:spaceId/notebook" element={<NotebookPage />} />
      <Route path="/spaces/:spaceId/assistant" element={<AssistantPage />} />
      <Route path="/spaces/:spaceId/assistant/:conversationId" element={<AssistantPage />} />
      <Route path="/spaces/:spaceId/members" element={<MembersPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

async function expectNoViolations(container: HTMLElement) {
  // The rail and the dialogs portal beside the container, so the whole body
  // is what a user meets — and what axe should see.
  expect(await axe(container.ownerDocument.body, RUN_ONLY)).toHaveNoViolations();
}

describe('PRD §18 — axe over the primary screens', () => {
  it('home with one space listed', async () => {
    const { container } = renderAt('/');
    await screen.findByRole('heading', { name: 'Sleep and memory' });
    await expectNoViolations(container);
  });

  it('space page (source library) with every source state on show', async () => {
    const { container } = renderAt('/spaces/space-1');
    await screen.findByRole('heading', { name: 'Sleep and memory' });
    await screen.findByText('Pasted abstract');
    await expectNoViolations(container);
  });

  it('source reader', async () => {
    const { container } = renderAt('/spaces/space-1/sources/src-1');
    await screen.findByText('SWS downscales synaptic weights across neocortex.');
    await expectNoViolations(container);
  });

  it('assistant hub', async () => {
    const { container } = renderAt('/spaces/space-1/assistant');
    await screen.findByRole('navigation', { name: 'Chats' });
    await screen.findByLabelText('Your question');
    await expectNoViolations(container);
  });

  it('assistant thread with a cited answer', async () => {
    const { container } = renderAt('/spaces/space-1/assistant/conv-1');
    await screen.findByText(/Recall drops after a short night/);
    await expectNoViolations(container);
  });

  it('notes page with the note viewer open', async () => {
    const { container } = renderAt('/spaces/space-1/notes?noteId=note-1');
    await screen.findByText('Methodology considerations for EEG trials');
    await screen.findByRole('complementary', { name: /slow-wave sleep/i });
    await expectNoViolations(container);
  });

  it('notes page with the New Note dialog open', async () => {
    const person = userEvent.setup();
    const { container } = renderAt('/spaces/space-1/notes');
    await person.click(await screen.findByRole('button', { name: /new note/i }));
    await screen.findByRole('dialog');
    await expectNoViolations(container);
  });

  it('notebook with the Research panel open', async () => {
    const { container } = renderAt('/spaces/space-1/notebook');
    await screen.findByRole('textbox', { name: 'Notebook' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Research panel' })).toHaveTextContent('Slow-wave sleep'));
    await expectNoViolations(container);
  });

  it('members page with the roster, a pending invite, and the Invite dialog open', async () => {
    const person = userEvent.setup();
    const { container } = renderAt('/spaces/space-1/members');
    await screen.findByRole('heading', { name: '2 members' });
    await expectNoViolations(container);
    await person.click(screen.getByRole('button', { name: 'Invite' }));
    await screen.findByRole('dialog');
    await expectNoViolations(container);
  });

  it('invite landing page', async () => {
    const { container } = renderAt('/invite/tok-1');
    await screen.findByRole('heading', { name: 'Sleep and memory' });
    await expectNoViolations(container);
  });
});
