/**
 * Single entry point for API calls.
 *
 * Requests go to /api, which the Vite dev server proxies to the backend, so the
 * session cookie is same-origin in development as well as production.
 */
const BASE_URL = '/api';

export interface FieldErrors {
  [field: string]: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrors;
  /**
   * The whole error body, for the few responses that carry more than the
   * envelope — a notebook save conflict returns the server's current document
   * beside `error` so the client can offer "Reload" without a second request.
   */
  readonly body: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: FieldErrors = {},
    body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.body = body;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; fields?: FieldErrors };
}

const NETWORK_MESSAGE =
  'We could not reach the server. Check that the API is running, then try again.';

const MALFORMED_MESSAGE =
  'The server returned a response we could not read. Please try again.';

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  // A multipart upload is handed to fetch untouched: the browser writes the
  // `content-type` with the boundary, and JSON.stringify would destroy the body.
  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      // Cookie-based sessions: every request carries the sid cookie.
      credentials: 'include',
      headers: {
        ...(body === undefined || isMultipart ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: isMultipart ? body : JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_MESSAGE);
  }

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) throw envelopeError(response.status, payload);

  // A 2xx that isn't the JSON we expect (an HTML error page from a proxy, a body
  // that failed to parse) must fail here. Handing `null` back as `T` only moves
  // the failure into a caller's destructuring, far from the cause.
  if (payload === null) {
    throw new ApiError(response.status, 'malformed_response', MALFORMED_MESSAGE);
  }

  return payload as T;
}

/** The backend's `{ error: { code, message, fields } }` envelope as an `ApiError`. */
function envelopeError(status: number, payload: unknown): ApiError {
  const envelope = (payload ?? {}) as ErrorEnvelope;
  return new ApiError(
    status,
    envelope.error?.code ?? 'request_failed',
    envelope.error?.message ?? 'That request could not be completed.',
    envelope.error?.fields ?? {},
    payload,
  );
}

/**
 * A text body rather than JSON — the Markdown export. Errors still arrive as the
 * JSON envelope, so failure handling is `request`'s.
 */
export async function requestText(path: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { method: 'GET', credentials: 'include' });
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    const isJson = response.headers.get('content-type')?.includes('application/json');
    throw envelopeError(response.status, isJson ? await response.json().catch(() => null) : null);
  }
  return response.text();
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---- Endpoint types -------------------------------------------------------

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface DependencyStatus {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  db: DependencyStatus;
  redis: DependencyStatus;
  /** The ingestion queue: sources sit in `processing` forever without it. */
  queue: DependencyStatus;
  /** The HuggingFace Inference API: no embeddings means no ingestion and no retrieval. */
  embeddings: DependencyStatus;
}

export const authApi = {
  me: () => api.get<{ user: User }>('/auth/me'),
  login: (input: { email: string; password: string }) =>
    api.post<{ user: User }>('/auth/login', input),
  register: (input: { name: string; email: string; password: string }) =>
    api.post<{ user: User }>('/auth/register', input),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  forgot: (input: { email: string }) =>
    api.post<{ ok: true; message: string }>('/auth/forgot', input),
  reset: (input: { token: string; password: string }) =>
    api.post<{ ok: true }>('/auth/reset', input),
};

export const healthApi = {
  get: () => api.get<Health>('/health'),
};

/** A member's standing in a space: owner > editor > viewer (shared-spaces-v1). */
export type SpaceRole = 'owner' | 'editor' | 'viewer';

/** Who did something; null once that account is gone. */
export interface Actor {
  id: string;
  name: string;
}

export interface Space {
  id: string;
  name: string;
  objective: string | null;
  /**
   * The owner's "Audience & style" note — who this space's answers are written
   * for and in what register. Every role reads it; only the owner may set it
   * (wiki-docs/plan/space-audience-style).
   */
  audienceInstruction: string | null;
  /** The configured cap on that note, from `AppConfig` (PRD §5). */
  audienceInstructionMaxChars: number;
  /** Set while the space is archived; archiving never deletes content (PRD §4). */
  archivedAt: string | null;
  /** When *the signed-in user* last opened it — resume is per member. */
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  noteCount: number;
  /** The signed-in user's role here; every write affordance is gated on it. */
  myRole: SpaceRole;
  ownerName: string;
  memberCount: number;
}

export type SpaceFilter = 'active' | 'archived';

export interface SpaceInput {
  name?: string;
  objective?: string;
}

export const spacesApi = {
  list: (filter: SpaceFilter) => api.get<{ spaces: Space[] }>(`/spaces?filter=${filter}`),
  get: (id: string) => api.get<{ space: Space }>(`/spaces/${id}`),
  create: (input: SpaceInput) => api.post<{ space: Space }>('/spaces', input),
  update: (id: string, input: SpaceInput) => api.patch<{ space: Space }>(`/spaces/${id}`, input),
  /** Stamps `lastOpenedAt`. Reading a space deliberately does not. */
  open: (id: string) => api.post<{ space: Space }>(`/spaces/${id}/open`),
  archive: (id: string) => api.post<{ space: Space }>(`/spaces/${id}/archive`),
  restore: (id: string) => api.post<{ space: Space }>(`/spaces/${id}/restore`),
  /**
   * Owner-only, and its own route rather than a field on `update`: that one is
   * open to editors.
   */
  setAudience: (id: string, audience: string | null) =>
    api.put<{ space: Space }>(`/spaces/${id}/audience`, { audience }),
};

export type SourceType = 'pdf' | 'web' | 'manual';
export type SourceState = 'processing' | 'ready' | 'failed';

/**
 * What the list shows, and no more. Extracted text, passages, embeddings, and
 * anything about where the file is stored stay server-side (PRD §7/§17).
 */
export interface Source {
  id: string;
  spaceId: string;
  type: SourceType;
  title: string;
  author: string | null;
  url: string | null;
  state: SourceState;
  /** Plain-language reason, present only while `state === 'failed'`. */
  errorMessage: string | null;
  /** Set while archived: excluded from the library's default view and from retrieval. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who brought the evidence in. Absent only in fixtures written before sharing. */
  addedBy?: Actor | null;
}

/** `GET /sources/:id` adds the shape the reader needs before it can ask for a page. */
export interface SourceDetail extends Source {
  blockCount: number;
  /** The highest page number, or null for a source with no page data (PRD §8). */
  pageCount: number | null;
}

/** One located unit of extracted text: the reader's unit, and a highlight's unit. */
export interface SourceBlock {
  ord: number;
  text: string;
  page: number | null;
  paragraphIndex: number | null;
  heading: string | null;
}

export interface SourceOutline {
  blockCount: number;
  pageCount: number | null;
  headings: { ord: number; page: number | null; heading: string }[];
}

/** Where a citation points, resolved server-side so only one place reads locators. */
export interface CitationTarget {
  sourceId: string;
  spaceId: string;
  passageId: string | null;
  startBlockOrd: number | null;
  endBlockOrd: number | null;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  /** True when the cited passage did not survive a reprocess (PRD §6/§10). */
  stale: boolean;
}

export type SourceInput =
  | { type: 'web'; url: string }
  | { type: 'manual'; title: string; content: string; author?: string };

/** PRD §7: a search query and the filters it combines with. */
export interface SourceListParams {
  q?: string;
  type?: SourceType;
  archived?: 'exclude' | 'only';
}

export interface SourceMetadataInput {
  title: string;
  author?: string | null;
}

function listQuery(params: SourceListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.type) search.set('type', params.type);
  if (params.archived === 'only') search.set('archived', 'only');
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const sourcesApi = {
  list: (spaceId: string, params: SourceListParams = {}) =>
    api.get<{ sources: Source[] }>(`/spaces/${spaceId}/sources${listQuery(params)}`),
  get: (id: string) => api.get<{ source: SourceDetail }>(`/sources/${id}`),
  update: (id: string, input: SourceMetadataInput) =>
    api.patch<{ source: Source }>(`/sources/${id}`, input),
  archive: (id: string) => api.post<{ source: Source }>(`/sources/${id}/archive`),
  restore: (id: string) => api.post<{ source: Source }>(`/sources/${id}/restore`),
  outline: (id: string) => api.get<SourceOutline>(`/sources/${id}/outline`),
  /** Page mode for a PDF, window mode for everything else — see the reader. */
  blocks: (id: string, params: { page?: number; from?: number; limit?: number }) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    return api.get<{ blocks: SourceBlock[] }>(`/sources/${id}/blocks?${search.toString()}`);
  },
  create: (spaceId: string, input: SourceInput) =>
    api.post<{ source: Source }>(`/spaces/${spaceId}/sources`, input),
  /** Multipart, so the PDF streams instead of being read into memory as base64. */
  upload: (spaceId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ source: Source }>(`/spaces/${spaceId}/sources/upload`, {
      method: 'POST',
      body: form,
    });
  },
  retry: (id: string) => api.post<{ source: Source }>(`/sources/${id}/retry`),
  remove: (id: string) => api.delete<void>(`/sources/${id}`),
};

/** A passage's location, for a reader opened at `?passage=`. No passage text. */
export interface PassageLocation {
  id: string;
  sourceId: string;
  ord: number;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  startBlockOrd: number | null;
  endBlockOrd: number | null;
}

export const passagesApi = {
  get: (id: string) => api.get<{ passage: PassageLocation }>(`/passages/${id}`),
};

export const citationsApi = {
  /** Inert until Phase 4 produces citations; the reader reads targets from here. */
  target: (id: string) => api.get<{ target: CitationTarget }>(`/citations/${id}/target`),
};

// --- The assistant (PRD §9) ---

export interface Conversation {
  id: string;
  spaceId: string;
  title: string;
  scopeType: 'space' | 'source';
  scopeSourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A row of the history list: the conversation plus what the row shows beside
 * its title. Only `conversationsApi.list` returns these.
 */
export interface ConversationListItem extends Conversation {
  /** The newest question, cut to one line server-side; null before any is asked. */
  preview: string | null;
  messageCount: number;
}

export interface MessageCitation {
  id: string;
  index: number;
  sourceId: string;
  sourceTitle: string;
  quotedText: string;
  reference: string;
  stale: boolean;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  feedback: 'useful' | 'not_useful' | null;
  /** Null on a user turn: only an answer makes a groundedness claim. */
  grounded: boolean | null;
  /** How many excerpts were searched for this answer. Null on a user turn. */
  passagesSent: number | null;
  sourcesUsed: { id: string; title: string }[];
  citations: MessageCitation[];
  /** The note this answer was saved into, when one exists (PRD §11). */
  savedNoteId: string | null;
  createdAt: string;
}

export interface ScopeInput {
  scopeType: 'space' | 'source';
  scopeSourceId?: string;
}

export const conversationsApi = {
  list: (spaceId: string) =>
    api.get<{ conversations: ConversationListItem[] }>(`/spaces/${spaceId}/conversations`),
  create: (spaceId: string, input: ScopeInput) =>
    api.post<{ conversation: Conversation }>(`/spaces/${spaceId}/conversations`, input),
  get: (id: string) =>
    api.get<{ conversation: Conversation; messages: ConversationMessage[] }>(`/conversations/${id}`),
  setScope: (id: string, input: ScopeInput) =>
    api.patch<{ conversation: Conversation }>(`/conversations/${id}`, input),
  feedback: (messageId: string, feedback: 'useful' | 'not_useful' | null) =>
    api.post<{ ok: true }>(`/messages/${messageId}/feedback`, { feedback }),
};

// --- Notes & Saved Answers (PRD §10, §11, §12) ---

export type NoteOrigin = 'user' | 'saved_answer';

export interface NoteCitation {
  id: string;
  sourceId: string;
  sourceTitle: string;
  quotedText: string;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  stale: boolean;
  createdAt: string;
}

export interface ConvertedSourceSummary {
  id: string;
  title: string;
  state: 'processing' | 'ready' | 'failed';
}

export interface Note {
  id: string;
  spaceId: string;
  title: string;
  contentRich: unknown;
  originType: NoteOrigin;
  originConversationId: string | null;
  originMessageId: string | null;
  citationCount: number;
  citations: NoteCitation[];
  convertedSource: ConvertedSourceSummary | null;
  /** Who created the note — the saver, for a saved answer. */
  author?: Actor | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNoteInput {
  title: string;
  contentRich?: Record<string, unknown>;
}

export interface UpdateNoteInput {
  title?: string;
  contentRich?: Record<string, unknown>;
}

export interface SaveAnswerAsNoteInput {
  title?: string;
}

export interface ConvertNoteToSourceInput {
  title?: string;
}

export const notesApi = {
  list: (spaceId: string, q?: string) =>
    api.get<{ notes: Note[] }>(`/spaces/${spaceId}/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  get: (id: string) => api.get<{ note: Note }>(`/notes/${id}`),
  create: (spaceId: string, input: CreateNoteInput) =>
    api.post<{ note: Note }>(`/spaces/${spaceId}/notes`, input),
  update: (id: string, input: UpdateNoteInput) =>
    api.patch<{ note: Note }>(`/notes/${id}`, input),
  remove: (id: string) => api.delete<void>(`/notes/${id}`),
  saveAsNote: (messageId: string, input?: SaveAnswerAsNoteInput) =>
    api.post<{ note: Note }>(`/messages/${messageId}/save-as-note`, input),
  convertToSource: (id: string, input?: ConvertNoteToSourceInput) =>
    api.post<{ source: Source }>(`/notes/${id}/convert-to-source`, input),
};

/**
 * Asking is the one call that is not `request()`: the answer arrives as an event
 * stream on the POST response, so it needs the raw `fetch` body rather than a
 * parsed JSON envelope. `EventSource` cannot be used at all — it only issues GET
 * requests and cannot carry a body.
 */
export function askUrl(conversationId: string): string {
  return `${BASE_URL}/conversations/${conversationId}/messages`;
}

// ---- Notebook (PRD §13, §14) ----------------------------------------------

export interface Notebook {
  id: string;
  spaceId: string;
  /** A Tiptap/ProseMirror JSON document; the server validates its shape. */
  contentRich: unknown;
  /** Who last saved — named in the conflict message. */
  updatedBy?: Actor | null;
  createdAt: string;
  updatedAt: string;
}

export const notebookApi = {
  get: (spaceId: string) => api.get<{ notebook: Notebook }>(`/spaces/${spaceId}/notebook`),
  /** Whole-document save, guarded by the `updatedAt` the client last saw (409 `notebook_conflict`). */
  save: (spaceId: string, input: { contentRich: unknown; baseUpdatedAt: string }) =>
    api.put<{ notebook: Notebook }>(`/spaces/${spaceId}/notebook`, input),
  exportPath: (spaceId: string) => `${BASE_URL}/spaces/${spaceId}/notebook/export.md`,
  exportMarkdown: (spaceId: string) => requestText(`/spaces/${spaceId}/notebook/export.md`),
  /** Who has the notebook open in edit mode right now — advisory (shared-spaces-v1). */
  presence: (spaceId: string) => api.get<{ users: Actor[] }>(`/spaces/${spaceId}/notebook/presence`),
  heartbeat: (spaceId: string) => api.post<{ users: Actor[] }>(`/spaces/${spaceId}/notebook/presence`),
  leavePresence: (spaceId: string) => api.delete<void>(`/spaces/${spaceId}/notebook/presence`),
};

// --- Activity (PRD §15) ----------------------------------------------------

export interface ActivityTarget {
  type: 'space' | 'source' | 'note' | 'notebook' | 'user';
  id: string;
  title: string;
}

export interface ActivitySpace {
  id: string;
  name: string;
  archivedAt: string | null;
}

/** The closed set the backend writes (`routes/activity.ts`); the panel's `switch` is exhaustive over it. */
export type ActivityKind =
  | 'space.created'
  | 'source.added'
  | 'source.ready'
  | 'source.failed'
  | 'note.saved_answer'
  | 'note.created'
  | 'note.edited'
  | 'note.converted'
  | 'note.deleted'
  | 'notebook.exported'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'member.role_changed'
  | 'space.ownership_transferred'
  | 'space.audience_changed';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  /** Who did it; null once that account is gone. */
  actor: Actor | null;
  space: ActivitySpace | null;
  target: ActivityTarget | null;
  href: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

export const activityApi = {
  list: ({ limit = 20, cursor }: { limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return api.get<ActivityPage>(`/activity?${params.toString()}`);
  },
  /** Every member's actions in one space, newest first (shared-spaces-v1). */
  listForSpace: (spaceId: string, { limit = 20, cursor }: { limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return api.get<ActivityPage>(`/spaces/${spaceId}/activity?${params.toString()}`);
  },
};

// --- Members & invites (shared-spaces-v1) ----------------------------------

export interface SpaceMember {
  userId: string;
  name: string;
  email: string;
  role: SpaceRole;
  joinedAt: string;
}

export interface SpaceInvite {
  id: string;
  email: string;
  role: SpaceRole;
  expiresAt: string;
  createdAt: string;
}

/** What an invite link resolves to for the signed-in, matching account. */
export interface InvitePreview {
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
  inviterName: string;
  expiresAt: string;
  alreadyMember: boolean;
}

export type GrantableRole = Exclude<SpaceRole, 'owner'>;

export const membersApi = {
  list: (spaceId: string) =>
    api.get<{ members: SpaceMember[]; invites: SpaceInvite[] }>(`/spaces/${spaceId}/members`),
  /** Returns the link once; "copy again" is `rotate`, which mints a new token. */
  invite: (spaceId: string, input: { email: string; role: GrantableRole }) =>
    api.post<{ invite: SpaceInvite; url: string }>(`/spaces/${spaceId}/invites`, input),
  rotate: (spaceId: string, inviteId: string) =>
    api.post<{ invite: SpaceInvite; url: string }>(`/spaces/${spaceId}/invites/${inviteId}/rotate`),
  revoke: (spaceId: string, inviteId: string) =>
    api.delete<void>(`/spaces/${spaceId}/invites/${inviteId}`),
  preview: (token: string) => api.get<{ invite: InvitePreview }>(`/invites/${encodeURIComponent(token)}`),
  accept: (token: string) =>
    api.post<{ spaceId: string; role: SpaceRole }>(`/invites/${encodeURIComponent(token)}/accept`),
  setRole: (spaceId: string, userId: string, role: GrantableRole) =>
    api.patch<{ member: SpaceMember }>(`/spaces/${spaceId}/members/${userId}`, { role }),
  remove: (spaceId: string, userId: string) =>
    api.delete<void>(`/spaces/${spaceId}/members/${userId}`),
  leave: (spaceId: string) => api.post<void>(`/spaces/${spaceId}/leave`),
  transfer: (spaceId: string, userId: string) =>
    api.post<{ ownerId: string }>(`/spaces/${spaceId}/transfer`, { userId }),
};

