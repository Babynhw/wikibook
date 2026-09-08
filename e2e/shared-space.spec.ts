import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { MANUAL_SOURCE } from './fixtures/manual-text';

/**
 * Shared spaces v1 (wiki-docs/plan/shared-spaces-v1) — three people in one
 * space, each in their own browser context: the owner invites, an editor
 * accepts and adds evidence, a viewer reads and is refused writes, the two
 * editors meet over the notebook, and the owner removes the editor. Against a
 * running local stack (see README.md); every run creates its own accounts.
 *
 * Nothing here needs the answer provider: the assistant is not asked, so this
 * spec is cheap to run beside `mvp-scenario.spec.ts`.
 */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'correct horse battery';
const STAMP = Date.now();
const SPACE_NAME = `Shared harbour study ${new Date(STAMP).toISOString().slice(0, 16)}`;

interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
}

let owner: Person;
let editor: Person;
let viewer: Person;
let spaceId = '';
let editorInviteUrl = '';
let viewerInviteUrl = '';

async function person(browser: Browser, name: string, slug: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { name, email: `e2e+${slug}-${STAMP}@example.test`, context, page };
}

async function register(who: Person) {
  await who.page.goto('/register');
  await who.page.getByLabel('Name').fill(who.name);
  await who.page.getByLabel('Email').fill(who.email);
  await who.page.getByLabel('Password').fill(PASSWORD);
  await who.page.getByRole('button', { name: 'Create account' }).click();
  await expect(who.page.getByRole('heading', { name: new RegExp(`^Welcome, ${who.name}`) })).toBeVisible();
}

/**
 * Opening a space stamps `lastOpenedAt` from an effect, a beat after the page
 * renders. A test that navigates away in the same instant aborts that request —
 * a person never does — so the steps that rely on the stamp wait for it.
 */
const stamped = (who: Person) =>
  who.page.waitForResponse((r) => r.url().includes('/open') && r.request().method() === 'POST');

/** Invites `who` from the owner's members page and returns the one-time link. */
async function invite(who: Person, role: 'editor' | 'viewer'): Promise<string> {
  const page = owner.page;
  await page.goto(`/spaces/${spaceId}/members`);
  await page.getByRole('button', { name: 'Invite' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(who.email);
  await dialog.getByLabel('Role').selectOption(role);
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = await dialog.locator('p.select-all').textContent();
  expect(link, 'the invite link is shown once').toMatch(/\/invite\//);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(who.email)).toBeVisible();
  return link!.trim();
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  owner = await person(browser, 'Owner Tan', 'owner');
  editor = await person(browser, 'Editor Minh', 'editor');
  viewer = await person(browser, 'Viewer Linh', 'viewer');
});

test.afterAll(async () => {
  for (const who of [owner, editor, viewer]) await who?.context.close();
});

test('01 the owner creates an account and a space', async () => {
  await register(owner);
  await owner.page.getByRole('button', { name: 'New space' }).click();
  const dialog = owner.page.getByRole('dialog', { name: 'New research space' });
  await dialog.getByLabel('Name').fill(SPACE_NAME);
  await dialog.getByRole('button', { name: 'Create space' }).click();
  await expect(dialog).toBeHidden();
  const opened = stamped(owner);
  await owner.page.getByRole('link', { name: SPACE_NAME }).click();
  await expect(owner.page).toHaveURL(/\/spaces\/[^/]+$/);
  spaceId = owner.page.url().split('/spaces/')[1]!.split(/[/?#]/)[0]!;
  await opened;
  // A solo owner sees no sharing line: the space looks exactly as before.
  await expect(owner.page.getByText(/owned by/)).toBeHidden();
});

test('02 the owner invites an editor and a viewer; the links are shown once', async () => {
  editorInviteUrl = await invite(editor, 'editor');
  viewerInviteUrl = await invite(viewer, 'viewer');
  await expect(owner.page.getByRole('heading', { name: 'Pending invites' })).toBeVisible();
});

test('03 a stranger with the link sees one neutral page', async () => {
  // The viewer's account, on the editor's link: wrong email → the same page an
  // expired or unknown link gets, naming nothing about the space.
  await register(viewer);
  await viewer.page.goto(new URL(editorInviteUrl).pathname);
  await expect(viewer.page.getByRole('heading', { name: /isn’t valid/ })).toBeVisible();
  await expect(viewer.page.getByText(SPACE_NAME)).toBeHidden();
});

test('04 the editor registers through the link and accepts', async () => {
  await editor.page.goto(new URL(editorInviteUrl).pathname);
  // Signed out → sign in, and back to the invite afterwards.
  await expect(editor.page).toHaveURL(/\/login/);
  await editor.page.getByRole('link', { name: 'Create one' }).click();
  await expect(editor.page).toHaveURL(/\/register/);
  // Registration lands on Home (awaited, so the session is set before moving
  // on); the link still works once signed in.
  await register(editor);
  await editor.page.goto(new URL(editorInviteUrl).pathname);
  await expect(editor.page.getByRole('heading', { name: SPACE_NAME })).toBeVisible();
  await expect(editor.page.getByText('Editor', { exact: true })).toBeVisible();
  const opened = stamped(editor);
  await editor.page.getByRole('button', { name: 'Accept and open' }).click();
  await expect(editor.page).toHaveURL(new RegExp(`/spaces/${spaceId}$`));
  await expect(editor.page.getByText(/owned by Owner Tan/)).toBeVisible();
  await opened;
  // The link is consumed: a second visit is the neutral page.
  await editor.page.goto(new URL(editorInviteUrl).pathname);
  await expect(editor.page.getByRole('heading', { name: /isn’t valid/ })).toBeVisible();
});

test('05 the editor adds a manual source; everyone sees who added it', async () => {
  await editor.page.goto(`/spaces/${spaceId}`);
  await editor.page.getByRole('main').getByRole('button', { name: 'Add source' }).click();
  const dialog = editor.page.getByRole('dialog');
  await dialog.getByRole('tab', { name: /text/i }).click();
  await dialog.getByLabel('Title').fill(MANUAL_SOURCE.title);
  await dialog.getByRole('textbox', { name: 'Text', exact: true }).fill(MANUAL_SOURCE.body);
  await dialog.getByRole('button', { name: /add/i }).last().click();
  await expect(dialog).toBeHidden();
  await expect(editor.page.getByText(new RegExp(`added .* by you`))).toBeVisible();

  await owner.page.goto(`/spaces/${spaceId}`);
  await expect(owner.page.getByText(new RegExp(`added .* by Editor Minh`))).toBeVisible();
  // The owner's own visit marker: the editor's source arrived since the owner was last here.
  await expect(owner.page.getByText('New since your last visit')).toBeVisible();
});

test('06 the viewer accepts, reads, and is offered no write control', async () => {
  await viewer.page.goto(new URL(viewerInviteUrl).pathname);
  await viewer.page.getByRole('button', { name: 'Accept and open' }).click();
  await expect(viewer.page).toHaveURL(new RegExp(`/spaces/${spaceId}$`));
  await expect(viewer.page.getByText('Viewer', { exact: true })).toBeVisible();
  await expect(viewer.page.getByText(/needs an editor role/)).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Add source' })).toHaveCount(0);
  await expect(viewer.page.getByText(MANUAL_SOURCE.title)).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // A forged write answers 403 for a member, and never 404.
  const forged = await viewer.page.request.post(`/api/spaces/${spaceId}/sources`, {
    data: { type: 'manual', title: 'Forged', content: 'text' },
  });
  expect(forged.status()).toBe(403);
  expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');

  await viewer.page.goto(`/spaces/${spaceId}/notes`);
  await expect(viewer.page.getByRole('button', { name: 'New note' })).toHaveCount(0);
  await viewer.page.goto(`/spaces/${spaceId}/notebook`);
  await expect(viewer.page.getByText(/needs an editor role/)).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Export' })).toBeVisible();
});

test('07 presence: the owner sees the editor editing, steps in anyway, and the loser gets a named conflict', async () => {
  await editor.page.goto(`/spaces/${spaceId}/notebook`);
  const editorBox = editor.page.getByRole('textbox', { name: 'Notebook' });
  await expect(editorBox).toHaveAttribute('contenteditable', 'true');

  await owner.page.goto(`/spaces/${spaceId}/notebook`);
  await expect(owner.page.getByText('Editor Minh is editing').first()).toBeVisible();
  await expect(owner.page.getByText(/You are reading so you do not overwrite/)).toBeVisible();
  const ownerBox = owner.page.getByRole('textbox', { name: 'Notebook' });
  await expect(ownerBox).toHaveAttribute('contenteditable', 'false');
  await owner.page.getByRole('button', { name: 'Edit anyway' }).click();
  await expect(ownerBox).toHaveAttribute('contenteditable', 'true');
  await expect(editor.page.getByText('Owner Tan is editing').first()).toBeVisible();

  // Both type from the same base; the second save collides and names the first saver.
  await editorBox.click();
  await editorBox.pressSequentially('Editor line. ');
  await expect(editor.page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
  await ownerBox.click();
  await ownerBox.pressSequentially('Owner line. ');
  await expect(owner.page.getByText(/Editor Minh saved a newer version/)).toBeVisible({ timeout: 10_000 });
  await expect(owner.page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Reload' }).click();
  await expect(ownerBox).toContainText('Editor line.');
});

test('08 the space feed names every actor; the editor’s Home feed does not carry the owner’s actions', async () => {
  await viewer.page.goto(`/spaces/${spaceId}/activity`);
  await expect(viewer.page.getByText(new RegExp(`Editor Minh · Added source`))).toBeVisible();
  await expect(viewer.page.getByText(/Viewer Linh · Joined the space/)).toBeVisible();
  await expect(viewer.page.getByText(/Owner Tan · Invited/).first()).toBeVisible();

  await editor.page.goto('/');
  await expect(editor.page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
  await expect(editor.page.getByText(/Joined the space/)).toBeVisible();
  await expect(editor.page.getByText(/Invited/)).toHaveCount(0);
});

test('09 the owner removes the editor; their next navigation is a 404 and their source stays', async () => {
  await owner.page.goto(`/spaces/${spaceId}/members`);
  await owner.page.getByRole('button', { name: 'Remove Editor Minh' }).click();
  const dialog = owner.page.getByRole('dialog');
  await expect(dialog).toContainText(/Sources and notes they added stay/);
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog).toBeHidden();
  await expect(owner.page.getByText(editor.email)).toBeHidden();

  await editor.page.goto(`/spaces/${spaceId}`);
  await expect(editor.page.getByRole('heading', { name: /could not find that space/ })).toBeVisible();

  await owner.page.goto(`/spaces/${spaceId}`);
  await expect(owner.page.getByText(MANUAL_SOURCE.title)).toBeVisible();
  await expect(owner.page.getByText(/added .* by Editor Minh/)).toBeVisible();
});

test('10 the viewer leaves; only the owner remains', async () => {
  await viewer.page.goto(`/spaces/${spaceId}/members`);
  await viewer.page.getByRole('button', { name: 'Leave space' }).click();
  await viewer.page.getByRole('dialog').getByRole('button', { name: 'Leave space' }).click();
  await expect(viewer.page).toHaveURL(/\/$/);
  await expect(viewer.page.getByRole('heading', { name: SPACE_NAME })).toHaveCount(0);

  await owner.page.goto(`/spaces/${spaceId}/members`);
  await expect(owner.page.getByRole('heading', { name: '1 member' })).toBeVisible();
});
