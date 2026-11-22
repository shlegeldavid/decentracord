import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import {
  createFixtureUser,
  expect,
  openSettingsSection,
  test
} from "./fixtures.js";
import type { APIResponse, Browser, BrowserContext, Page } from "@playwright/test";

const applicationOrigin = new URL(
  process.env.TEST_ORIGIN ?? process.env.E2E_BASE_URL ?? "http://decentracord.test:3000"
).origin;

interface Credentials {
  login: string;
  password: string;
}

interface AuthenticatedSession {
  context: BrowserContext;
  page: Page;
}

interface RoleSummary {
  id: string;
}

interface ChannelSummary {
  id: string;
}

interface MemberSummary {
  id: string;
  login: string;
}

async function login(page: Page, credentials: Credentials): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function newAuthenticatedPage(browser: Browser, credentials: Credentials): Promise<AuthenticatedSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, credentials);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function issueCsrf(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${applicationOrigin}/api/auth/csrf`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

function writeHeaders(csrfToken: string): Record<string, string> {
  return { origin: applicationOrigin, "x-csrf-token": csrfToken };
}

async function createRole(
  context: BrowserContext,
  csrfToken: string,
  name: string,
  permissions: string[]
): Promise<RoleSummary> {
  const response = await context.request.post(`${applicationOrigin}/api/roles`, {
    data: { name, permissions },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as RoleSummary;
}

async function createChannel(context: BrowserContext, csrfToken: string, name: string): Promise<ChannelSummary> {
  const response = await context.request.post(`${applicationOrigin}/api/channels`, {
    data: { name },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as ChannelSummary;
}

async function createMember(
  context: BrowserContext,
  csrfToken: string,
  login: string,
  password: string
): Promise<MemberSummary> {
  const response = await context.request.post(`${applicationOrigin}/api/members`, {
    data: { login, password },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as MemberSummary;
}

async function setChannelOverrides(
  context: BrowserContext,
  csrfToken: string,
  channelId: string,
  overrides: Array<Record<string, string | null>>
): Promise<void> {
  const response = await context.request.put(`${applicationOrigin}/api/channels/${channelId}/overrides`, {
    data: { overrides },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(204);
}

async function renameChannel(
  context: BrowserContext,
  csrfToken: string,
  channelId: string,
  name: string
): Promise<void> {
  const response = await context.request.patch(`${applicationOrigin}/api/channels/${channelId}`, {
    data: { name },
    headers: writeHeaders(csrfToken),
    failOnStatusCode: false
  });
  expect(response.status(), await response.text()).toBe(200);
}

function channelRow(page: Page, channelId: string) {
  return page.locator(`.channel-list[data-scope="workspace"] [data-channel-id="${channelId}"]`);
}

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(applicationOrigin)).find(({ name }) => name.endsWith("decentracord.sid"));
  expect(cookie, "authenticated session cookie").toBeTruthy();
  return `${cookie!.name}=${cookie!.value}`;
}

async function connectSocket(context: BrowserContext): Promise<Socket> {
  const socket = io(`${applicationOrigin}/realtime`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 7_000,
    transports: ["polling", "websocket"],
    extraHeaders: { cookie: await sessionCookie(context), origin: applicationOrigin }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime connection timed out")), 8_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect();
    });
    return socket;
  } catch (error) {
    socket.disconnect();
    throw error;
  }
}

async function subscribeToChannel(socket: Socket, channelId: string): Promise<{ event: string; payload: unknown }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("channel:subscribed", onSubscribed);
      socket.off("channel:subscribe:error", onError);
      reject(new Error("Channel subscription timed out"));
    }, 5_000);
    const onSubscribed = (payload: unknown) => {
      clearTimeout(timer);
      socket.off("channel:subscribe:error", onError);
      resolve({ event: "channel:subscribed", payload });
    };
    const onError = (payload: unknown) => {
      clearTimeout(timer);
      socket.off("channel:subscribed", onSubscribed);
      resolve({ event: "channel:subscribe:error", payload });
    };
    socket.once("channel:subscribed", onSubscribed);
    socket.once("channel:subscribe:error", onError);
    socket.emit("channel:subscribe", { channelId });
  });
}

function waitForSocketEvent(socket: Socket, event: string, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

function waitForSocketEventMatching(
  socket: Socket,
  event: string,
  matches: (payload: unknown) => boolean,
  timeoutMs = 5_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for matching ${event}`));
    }, timeoutMs);
    const onEvent = (payload: unknown) => {
      if (!matches(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    socket.on(event, onEvent);
  });
}

function expectNoSocketEvent(socket: Socket, event: string, windowMs = 750): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event} event: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, windowMs);
    socket.once(event, onEvent);
  });
}

async function assertApiError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

test.describe("channel visibility and delegated access", () => {
  test("enforces channel visibility, revocation, read-only channels, and role hierarchy", async ({ browser, page, identity, channelAccessSeed }) => {
    const suffix = Date.now().toString(36);
    const managerRoleName = `e2e-manager-${suffix}`;
    const higherRoleName = `e2e-higher-${suffix}`;
    const announcementsName = `e2e-announcements-${suffix}`;
    const manager = { login: `fixture_e2e_manager_${suffix}`, password: "E2E-manager-password-2026" };
    const lowerMember = { login: `fixture_e2e_target_${suffix}`, password: "E2E-target-password-2026" };
    const ordinary = identity.employee;
    expect(ordinary).toBeTruthy();
    if (!ordinary) return;

    await login(page, identity.admin);
    const adminContext = page.context();
    const adminCsrf = await issueCsrf(adminContext);
    const managerRole = await createRole(adminContext, adminCsrf, managerRoleName, ["MANAGE_ROLES", "VIEW_CHANNEL"]);
    const higherRole = await createRole(adminContext, adminCsrf, higherRoleName, []);
    const announcements = await createChannel(adminContext, adminCsrf, announcementsName);

    createFixtureUser({ login: manager.login, password: manager.password, roleName: managerRoleName });
    createFixtureUser({ login: lowerMember.login, password: lowerMember.password, roleName: channelAccessSeed.lowerRoleName });

    await setChannelOverrides(adminContext, adminCsrf, channelAccessSeed.channelId, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" },
      { subject: "role", subjectId: managerRole.id, permission: "VIEW_CHANNEL", effect: "allow" }
    ]);
    await setChannelOverrides(adminContext, adminCsrf, announcements.id, [
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" }
    ]);

    let deniedSession: AuthenticatedSession | undefined;
    let managerSession: AuthenticatedSession | undefined;
    let managerSocket: Socket | undefined;

    try {
      deniedSession = await newAuthenticatedPage(browser, ordinary);
      managerSession = await newAuthenticatedPage(browser, manager);

      const deniedChannel = channelRow(deniedSession.page, channelAccessSeed.channelId);
      const managerChannel = channelRow(managerSession.page, channelAccessSeed.channelId);
      const adminChannel = channelRow(page, channelAccessSeed.channelId);
      const announcementsRow = channelRow(managerSession.page, announcements.id);
      await expect(adminChannel).toBeVisible();
      await expect(deniedChannel).toHaveCount(0);
      await expect(managerChannel).toBeVisible();
      await expect(announcementsRow).toBeVisible();
      await expect(announcementsRow).toContainText("Только для чтения");

      const managerDetail = await managerSession.context.request.get(
        `${applicationOrigin}/api/channels/${channelAccessSeed.channelId}`,
        { failOnStatusCode: false }
      );
      expect(managerDetail.status()).toBe(200);
      expect(await managerDetail.json()).toMatchObject({
        channel: { id: channelAccessSeed.channelId, canView: true, ownerEditable: false },
        overrides: []
      });

      const deniedDetail = await deniedSession.context.request.get(
        `${applicationOrigin}/api/channels/${channelAccessSeed.channelId}`,
        { failOnStatusCode: false }
      );
      await assertApiError(deniedDetail, 404, "CHANNEL_NOT_FOUND");

      const announcementsDetail = await managerSession.context.request.get(
        `${applicationOrigin}/api/channels/${announcements.id}`,
        { failOnStatusCode: false }
      );
      expect(announcementsDetail.status()).toBe(200);
      expect(await announcementsDetail.json()).toMatchObject({
        channel: { id: announcements.id, canView: true, canSend: false, ownerEditable: false },
        overrides: []
      });

      const readOnlyToken = await issueCsrf(managerSession.context);
      const blockedMessage = await managerSession.context.request.post(
        `${applicationOrigin}/api/channels/${announcements.id}/messages`,
        {
          data: { message: "This announcement channel is read only" },
          headers: writeHeaders(readOnlyToken),
          failOnStatusCode: false
        }
      );
      await assertApiError(blockedMessage, 403, "SEND_NOT_ALLOWED");

      managerSocket = await connectSocket(managerSession.context);
      expect(await subscribeToChannel(managerSocket, channelAccessSeed.channelId)).toEqual({
        event: "channel:subscribed",
        payload: { channelId: channelAccessSeed.channelId }
      });

      const managerPositiveControl = waitForSocketEvent(managerSocket, "channel:updated");
      const positiveName = `e2e-positive-${suffix}`;
      await renameChannel(adminContext, adminCsrf, channelAccessSeed.channelId, positiveName);
      expect(await managerPositiveControl).toMatchObject({ channelId: channelAccessSeed.channelId, name: positiveName });

      const revokeEvent = waitForSocketEvent(managerSocket, "channel:revoked");
      await setChannelOverrides(adminContext, adminCsrf, channelAccessSeed.channelId, [
        { subject: "role", subjectId: managerRole.id, permission: "VIEW_CHANNEL", effect: "deny" }
      ]);
      expect(await revokeEvent).toMatchObject({ channelId: channelAccessSeed.channelId });
      await expect(managerChannel).toHaveCount(0, { timeout: 5_000 });
      await expect(adminChannel).toBeVisible();

      const revokedDetail = await managerSession.context.request.get(
        `${applicationOrigin}/api/channels/${channelAccessSeed.channelId}`,
        { failOnStatusCode: false }
      );
      await assertApiError(revokedDetail, 404, "CHANNEL_NOT_FOUND");

      expect(await subscribeToChannel(managerSocket, channelAccessSeed.channelId)).toEqual({
        event: "channel:subscribe:error",
        payload: { channelId: channelAccessSeed.channelId, code: "CHANNEL_NOT_FOUND" }
      });
      const revokedNoEvent = expectNoSocketEvent(managerSocket, "channel:updated", 1_000);
      const finalName = `e2e-after-revoke-${suffix}`;
      await renameChannel(adminContext, adminCsrf, channelAccessSeed.channelId, finalName);
      await revokedNoEvent;
      expect(managerSocket.connected).toBe(true);

      await openSettingsSection(managerSession.page, "Роли");
      const delegatedRolesButton = managerSession.page.getByRole("navigation", { name: "Разделы" }).getByRole("button", { name: "Роли", exact: true });
      await expect(delegatedRolesButton).toBeVisible();
      await expect(managerSession.page.getByRole("heading", { name: "Роли", exact: true })).toBeVisible();
      const lowerRoleRow = managerSession.page.locator(`[data-role-id="${channelAccessSeed.lowerRoleId}"]`);
      await expect(lowerRoleRow).toBeVisible();
      await lowerRoleRow.getByRole("button", { name: "Переименовать" }).click();
      const renamedLowerRole = `${channelAccessSeed.lowerRoleName}-edited`;
      await lowerRoleRow.getByLabel("Название роли").fill(renamedLowerRole);
      await lowerRoleRow.getByRole("button", { name: "Сохранить роль", exact: true }).click();
      await expect(managerSession.page.getByText(`Название роли изменено на «${renamedLowerRole}».`, { exact: true })).toBeVisible();

      await openSettingsSection(managerSession.page, "Участники");
      await expect(managerSession.page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
      const lowerMemberRow = managerSession.page.locator("[data-member-id]").filter({ hasText: lowerMember.login });
      await expect(lowerMemberRow).toBeVisible();
      await lowerMemberRow.getByRole("button", { name: "Роли" }).click();
      await lowerMemberRow.getByLabel(`Роли для ${lowerMember.login}`).selectOption(channelAccessSeed.lowerRoleId);
      await lowerMemberRow.getByRole("button", { name: "Сохранить роли" }).click();
      await expect(lowerMemberRow).toContainText(renamedLowerRole);
      const lowerMemberId = await lowerMemberRow.getAttribute("data-member-id");
      expect(lowerMemberId).toBeTruthy();

      const managerCsrf = await issueCsrf(managerSession.context);
      const missingPermission = await managerSession.context.request.patch(
        `${applicationOrigin}/api/roles/${channelAccessSeed.lowerRoleId}`,
        {
          data: { permissions: ["MANAGE_CHANNELS"] },
          headers: writeHeaders(managerCsrf),
          failOnStatusCode: false
        }
      );
      await assertApiError(missingPermission, 403, "MISSING_PERMISSION");

      const equalRole = await managerSession.context.request.patch(`${applicationOrigin}/api/roles/${managerRole.id}`, {
        data: { name: `${managerRoleName}-equal` },
        headers: writeHeaders(managerCsrf),
        failOnStatusCode: false
      });
      await assertApiError(equalRole, 403, "HIERARCHY");

      const higherRoleDenied = await managerSession.context.request.patch(`${applicationOrigin}/api/roles/${higherRole.id}`, {
        data: { name: `${higherRoleName}-denied` },
        headers: writeHeaders(managerCsrf),
        failOnStatusCode: false
      });
      await assertApiError(higherRoleDenied, 403, "HIERARCHY");

      const equalMemberRole = await managerSession.context.request.patch(
        `${applicationOrigin}/api/members/${lowerMemberId}/roles`,
        {
          data: { roleIds: [managerRole.id] },
          headers: writeHeaders(managerCsrf),
          failOnStatusCode: false
        }
      );
      await assertApiError(equalMemberRole, 403, "HIERARCHY");

      const higherMemberRole = await managerSession.context.request.patch(
        `${applicationOrigin}/api/members/${lowerMemberId}/roles`,
        {
          data: { roleIds: [higherRole.id] },
          headers: writeHeaders(managerCsrf),
          failOnStatusCode: false
        }
      );
      await assertApiError(higherMemberRole, 403, "HIERARCHY");
    } finally {
      managerSocket?.disconnect();
      await deniedSession?.context.close();
      await managerSession?.context.close();
    }
  }, 120_000);

  test("updates the open channel list after role assignment and base permission changes", async ({ browser, page, identity }) => {
    const suffix = Date.now().toString(36);
    const memberCredentials = {
      login: `fixture_live_access_${suffix}`,
      password: "E2E-live-access-password-2026"
    };

    await login(page, identity.admin);
    const adminContext = page.context();
    const adminCsrf = await issueCsrf(adminContext);
    const permissions = ["VIEW_CHANNEL", "SEND_MESSAGES"];
    const viewerRole = await createRole(adminContext, adminCsrf, `e2e-live-viewer-${suffix}`, permissions);
    const channelName = `e2e-live-channel-${suffix}`;
    const channel = await createChannel(adminContext, adminCsrf, channelName);
    const member = await createMember(adminContext, adminCsrf, memberCredentials.login, memberCredentials.password);
    const content = "Сообщение из закрытого канала";
    const sent = await adminContext.request.post(`${applicationOrigin}/api/channels/${channel.id}/messages`, {
      data: { content, clientRequestId: randomUUID() },
      headers: writeHeaders(adminCsrf)
    });
    expect(sent.status(), await sent.text()).toBe(201);
    let memberSession: AuthenticatedSession | undefined;
    let socket: Socket | undefined;
    const heldHistory = Promise.withResolvers<void>();

    try {
      memberSession = await newAuthenticatedPage(browser, memberCredentials);
      const memberChannel = channelRow(memberSession.page, channel.id);
      await expect(memberChannel).toHaveCount(0);
      socket = await connectSocket(memberSession.context);
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribe:error",
        payload: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
      });

      const assignedSync = waitForSocketEvent(socket, "channels:sync");
      const assignment = await adminContext.request.patch(`${applicationOrigin}/api/members/${member.id}/roles`, {
        data: { roleIds: [viewerRole.id] },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(assignment.status(), await assignment.text()).toBe(204);
      const assignedChannels = (await assignedSync as { channels?: Array<{ id: string }> }).channels;
      expect(assignedChannels?.some((visible) => visible.id === channel.id)).toBe(true);
      await expect(memberChannel).toBeVisible();
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribed",
        payload: { channelId: channel.id }
      });

      const historyPath = `/api/channels/${channel.id}/messages`;
      const matchesHistory = (url: URL) =>
        url.pathname === historyPath && !url.searchParams.has("before") && !url.searchParams.has("after");
      const fetchedHistory = Promise.withResolvers<void>();
      await memberSession.page.route(matchesHistory, async (route) => {
        const response = await route.fetch();
        const history = await response.json() as { messages: Array<{ content: string }> };
        expect(response.status()).toBe(200);
        expect(history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content })]));
        fetchedHistory.resolve();
        await heldHistory.promise;
        await route.fulfill({ response });
      }, { times: 1 });
      await memberChannel.locator(".channel-list-select").click();
      const heading = memberSession.page.getByRole("heading", { level: 2, name: channelName });
      await expect(heading).toBeVisible();
      await fetchedHistory.promise;

      const permissionRevokeSync = waitForSocketEvent(socket, "channels:sync");
      const permissionRevoked = waitForSocketEventMatching(
        socket,
        "channel:revoked",
        (payload) => typeof payload === "object" && payload !== null && "channelId" in payload && payload.channelId === channel.id
      );
      const removePermission = await adminContext.request.patch(`${applicationOrigin}/api/roles/${viewerRole.id}`, {
        data: { permissions: [] },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(removePermission.status(), await removePermission.text()).toBe(200);
      const hiddenChannels = (await permissionRevokeSync as { channels?: Array<{ id: string }> }).channels;
      expect(hiddenChannels?.some((visible) => visible.id === channel.id)).toBe(false);
      expect(await permissionRevoked).toMatchObject({ channelId: channel.id });
      await expect(memberChannel).toHaveCount(0);
      const revoked = memberSession.page.getByRole("heading", { name: "Доступ к каналу отозван" });
      await expect(revoked).toBeVisible();
      const deliveredHistory = memberSession.page.waitForResponse((response) => matchesHistory(new URL(response.url())));
      heldHistory.resolve();
      expect(await (await deliveredHistory).finished()).toBeNull();
      await memberSession.page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(heading).toBeVisible();
      await expect(revoked).toBeVisible();
      await expect(memberSession.page.getByText(content, { exact: true })).toHaveCount(0);
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribe:error",
        payload: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
      });
      expect(socket.connected).toBe(true);

      const permissionGrantSync = waitForSocketEvent(socket, "channels:sync");
      const restorePermission = await adminContext.request.patch(`${applicationOrigin}/api/roles/${viewerRole.id}`, {
        data: { permissions },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(restorePermission.status(), await restorePermission.text()).toBe(200);
      const visibleChannels = (await permissionGrantSync as { channels?: Array<{ id: string }> }).channels;
      expect(visibleChannels?.some((visible) => visible.id === channel.id)).toBe(true);
      await expect(memberChannel).toBeVisible();
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribed",
        payload: { channelId: channel.id }
      });

      const unassignedSync = waitForSocketEvent(socket, "channels:sync");
      const assignmentRevoked = waitForSocketEventMatching(
        socket,
        "channel:revoked",
        (payload) => typeof payload === "object" && payload !== null && "channelId" in payload && payload.channelId === channel.id
      );
      const unassignment = await adminContext.request.patch(`${applicationOrigin}/api/members/${member.id}/roles`, {
        data: { roleIds: [] },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(unassignment.status(), await unassignment.text()).toBe(204);
      const unassignedChannels = (await unassignedSync as { channels?: Array<{ id: string }> }).channels;
      expect(unassignedChannels?.some((visible) => visible.id === channel.id)).toBe(false);
      expect(await assignmentRevoked).toMatchObject({ channelId: channel.id });
      await expect(memberChannel).toHaveCount(0);
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribe:error",
        payload: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
      });
      expect(socket.connected).toBe(true);

      const reassignedSync = waitForSocketEvent(socket, "channels:sync");
      const reassignment = await adminContext.request.patch(`${applicationOrigin}/api/members/${member.id}/roles`, {
        data: { roleIds: [viewerRole.id] },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(reassignment.status(), await reassignment.text()).toBe(204);
      const reassignedChannels = (await reassignedSync as { channels?: Array<{ id: string }> }).channels;
      expect(reassignedChannels?.some((visible) => visible.id === channel.id)).toBe(true);
      await expect(memberChannel).toBeVisible();
      expect(await subscribeToChannel(socket, channel.id)).toEqual({
        event: "channel:subscribed",
        payload: { channelId: channel.id }
      });
      await memberChannel.locator(".channel-list-select").click();
      const offlineMessage = "Сообщение из очереди закрытого канала";
      const replayedIds: string[] = [];
      memberSession.page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === historyPath) {
          const { clientRequestId } = request.postDataJSON() as { clientRequestId: string };
          replayedIds.push(clientRequestId);
        }
      });
      await memberSession.context.setOffline(true);
      await expect(memberSession.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
      await memberSession.page.getByLabel("Сообщение").fill(offlineMessage);
      await memberSession.page.getByRole("button", { name: "Отправить", exact: true }).click();
      await expect(memberSession.page.locator(".message-pending.queued").filter({ hasText: offlineMessage })).toBeVisible();

      const revokeWhileOffline = await adminContext.request.patch(`${applicationOrigin}/api/roles/${viewerRole.id}`, {
        data: { permissions: [] },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(revokeWhileOffline.status(), await revokeWhileOffline.text()).toBe(200);
      await memberSession.context.setOffline(false);
      await expect(memberSession.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
      await expect(revoked).toBeVisible();
      await expect(memberSession.page.getByText(offlineMessage, { exact: true })).toHaveCount(0);
      expect(replayedIds).toEqual([]);

      const restoreAfterReconnect = await adminContext.request.patch(`${applicationOrigin}/api/roles/${viewerRole.id}`, {
        data: { permissions },
        headers: writeHeaders(adminCsrf),
        failOnStatusCode: false
      });
      expect(restoreAfterReconnect.status(), await restoreAfterReconnect.text()).toBe(200);
      await expect(memberChannel).toBeVisible();
      await memberChannel.locator(".channel-list-select").click();
      await expect(memberSession.page.getByText(offlineMessage, { exact: true })).toHaveCount(0);
      expect(replayedIds).toEqual([]);
    } finally {
      heldHistory.resolve();
      socket?.disconnect();
      await memberSession?.context.close();
    }
  }, 120_000);
});
