import { test, expect, createFixtureUser, openSettingsSection, type TestIdentity } from "./fixtures.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const applicationOrigin = process.env.E2E_BASE_URL ?? "http://decentracord.test:3000";

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: { login: string; password: string }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, credentials);
  return { context, page };
}

async function issueCsrf(request: BrowserContext["request"]): Promise<string> {
  const response = await request.get("/api/auth/csrf");
  expect(response.status()).toBe(200);
  const result = await response.json() as { csrfToken?: unknown };
  expect(typeof result.csrfToken).toBe("string");
  return result.csrfToken as string;
}

async function createRoleFromUi(page: Page, name: string, selectedPermissions: string[]): Promise<string> {
  const form = page.locator("[data-role-create-form]");
  await form.getByLabel("Название роли").fill(name);
  for (const permission of selectedPermissions) {
    await form.getByLabel(`Новое разрешение ${permission}`).check();
  }
  await form.getByRole("button", { name: "Создать роль" }).click();
  await expect(page.getByText(`Роль «${name}» создана.`, { exact: true })).toBeVisible();
  const row = page.locator("[data-role-id]").filter({ hasText: name });
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-role-id");
  if (!id) throw new Error(`Role ID is missing for ${name}`);
  return id;
}

async function loginAsAdmin(page: Page, identity: TestIdentity): Promise<void> {
  await login(page, identity.admin);
}

test.describe("role and member management UI", () => {
  test("manages roles, member assignments, delegation, and role-order channel access", async ({ browser, page, identity }) => {
    const suffix = Date.now().toString(36);
    const lowerTargetName = `Нижняя цель ${suffix}`;
    const readerRoleName = `Читатель каналов ${suffix}`;
    const managerRoleName = `Управляющий ролями ${suffix}`;
    const higherRoleName = `Верхняя роль ${suffix}`;
    const memberLogin = `role_member_${suffix}`;
    const memberPassword = "Role-member-password-2026";
    const channelName = `role-order-${suffix}`;
    const delegateLogin = `fixture_delegate_${suffix}`;
    const delegatePassword = "Delegated-role-password-2026";
    const employeeLogin = `fixture_role_employee_${suffix}`;
    const employeePassword = "Role-employee-password-2026";

    let delegateSession: { context: BrowserContext; page: Page } | undefined;
    let employeeSession: { context: BrowserContext; page: Page } | undefined;
    let readerSession: { context: BrowserContext; page: Page } | undefined;
    try {
      await loginAsAdmin(page, identity);
      await openSettingsSection(page, "Роли");
      await expect(page.getByRole("heading", { name: "Роли", exact: true })).toBeVisible();

      const lowerTargetRoleId = await createRoleFromUi(page, lowerTargetName, []);
      const readerRoleId = await createRoleFromUi(page, readerRoleName, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
      const managerRoleId = await createRoleFromUi(page, managerRoleName, ["MANAGE_ROLES"]);
      const higherRoleId = await createRoleFromUi(page, higherRoleName, ["SEND_MESSAGES"]);
      const bobberRoleId = await createRoleFromUi(page, "бобёр", []);

      const bobberRow = page.locator(`[data-role-id="${bobberRoleId}"]`);
      await bobberRow.getByRole("button", { name: "Переименовать" }).click();
      await bobberRow.getByLabel("Название роли").fill(`бобёр ${suffix}`);
      await bobberRow.getByRole("button", { name: "Сохранить роль", exact: true }).click();
      await expect(page.getByText(`Название роли изменено на «бобёр ${suffix}».`, { exact: true })).toBeVisible();
      await openSettingsSection(page, "Права");
      await page.locator(".permission-matrix").getByLabel("Роль", { exact: true }).selectOption(bobberRoleId);
      const bobberViewChannel = page.locator(".permission-matrix")
        .getByLabel(`Разрешение VIEW_CHANNEL для бобёр ${suffix}`);
      await bobberViewChannel.selectOption("granted");
      await expect(bobberViewChannel).toHaveValue("granted");

      const adminToken = await issueCsrf(page.context().request);
      const createdChannel = await page.context().request.post("/api/channels", {
        data: { name: channelName },
        headers: { origin: applicationOrigin, "x-csrf-token": adminToken },
        failOnStatusCode: false
      });
      expect(createdChannel.status()).toBe(201);

      await openSettingsSection(page, "Участники");
      await expect(page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Добавить участника", exact: true }).click();
      await page.getByLabel("Логин").fill(memberLogin);
      await page.getByLabel("Пароль").fill(memberPassword);
      await page.getByLabel("Роли нового участника").selectOption(readerRoleId);
      await page.getByRole("button", { name: "Создать участника" }).click();
      await expect(page.getByText("Участник создан. Пароль больше не отображается.", { exact: true })).toBeVisible();
      const memberRow = page.locator("[data-member-id]").filter({ hasText: memberLogin });
      await expect(memberRow).toContainText(readerRoleName);
      await expect(memberRow.getByRole("button", { name: "Сбросить пароль" })).toBeVisible();
      await expect(memberRow.getByRole("button", { name: "Отключить" })).toBeVisible();

      await memberRow.getByRole("button", { name: "Роли" }).click();
      const assignment = memberRow.getByLabel(`Роли для ${memberLogin}`);
      await assignment.selectOption([readerRoleId, bobberRoleId]);
      await memberRow.getByRole("button", { name: "Сохранить роли" }).click();
      await expect(memberRow).toContainText(`бобёр ${suffix}`);
      await memberRow.getByRole("button", { name: "Роли" }).click();
      await memberRow.getByLabel(`Роли для ${memberLogin}`).selectOption(readerRoleId);
      await memberRow.getByRole("button", { name: "Сохранить роли" }).click();
      await expect(memberRow).not.toContainText(`бобёр ${suffix}`);

      createFixtureUser({ login: delegateLogin, password: delegatePassword, roleName: managerRoleName });
      delegateSession = await newAuthenticatedPage(browser, { login: delegateLogin, password: delegatePassword });
      await openSettingsSection(delegateSession.page, "Роли");
      const delegateNavigation = delegateSession.page.getByRole("navigation", { name: "Разделы" });
      await expect(delegateNavigation.getByRole("button", { name: "Роли", exact: true })).toBeVisible();
      await openSettingsSection(delegateSession.page, "Права");
      await delegateSession.page.locator(".permission-matrix").getByLabel("Роль", { exact: true }).selectOption(lowerTargetRoleId);
      const delegatedViewChannel = delegateSession.page.locator(".permission-matrix")
        .getByLabel(`Разрешение VIEW_CHANNEL для ${lowerTargetName}`);
      await delegatedViewChannel.selectOption("granted");
      await expect(delegateSession.page.getByRole("alert")).toContainText("Вы не можете выдать разрешение, которого нет у вас.");

      const delegateToken = await issueCsrf(delegateSession.context.request);
      const missingPermission = await delegateSession.context.request.patch(`/api/roles/${lowerTargetRoleId}`, {
        data: { permissions: ["VIEW_CHANNEL"] },
        headers: { origin: applicationOrigin, "x-csrf-token": delegateToken },
        failOnStatusCode: false
      });
      expect(missingPermission.status()).toBe(403);
      expect((await missingPermission.json()).error.code).toBe("MISSING_PERMISSION");

      const sameRole = await delegateSession.context.request.patch(`/api/roles/${managerRoleId}`, {
        data: { permissions: ["MANAGE_ROLES"] },
        headers: { origin: applicationOrigin, "x-csrf-token": delegateToken },
        failOnStatusCode: false
      });
      expect(sameRole.status()).toBe(403);
      expect((await sameRole.json()).error.code).toBe("HIERARCHY");
      const higherRole = await delegateSession.context.request.patch(`/api/roles/${higherRoleId}`, {
        data: { name: `${higherRoleName} изменена` },
        headers: { origin: applicationOrigin, "x-csrf-token": delegateToken },
        failOnStatusCode: false
      });
      expect(higherRole.status()).toBe(403);
      expect((await higherRole.json()).error.code).toBe("HIERARCHY");

      await openSettingsSection(delegateSession.page, "Участники");
      await expect(delegateSession.page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
      await expect(delegateSession.page.getByRole("button", { name: "Сбросить пароль" })).toHaveCount(0);
      await expect(delegateSession.page.getByRole("button", { name: "Отключить" })).toHaveCount(0);

      createFixtureUser({ login: employeeLogin, password: employeePassword, roleName: "@everyone" });
      employeeSession = await newAuthenticatedPage(browser, { login: employeeLogin, password: employeePassword });
      await openSettingsSection(employeeSession.page, "Настройки аккаунта");
      const employeeNavigation = employeeSession.page.getByRole("navigation", { name: "Разделы" });
      await expect(employeeNavigation.getByRole("button", { name: "Роли", exact: true })).toHaveCount(0);
      await expect(employeeNavigation.getByRole("button", { name: "Участники", exact: true })).toHaveCount(0);
      expect((await employeeSession.context.request.get("/api/roles", { failOnStatusCode: false })).status()).toBe(403);

      readerSession = await newAuthenticatedPage(browser, { login: memberLogin, password: memberPassword });
      const beforeResponse = await readerSession.context.request.get("/api/channels", { failOnStatusCode: false });
      expect(beforeResponse.status()).toBe(200);
      const before = await beforeResponse.json() as { channels: Array<{ id: string; name: string }> };
      expect(before.channels.some((channel) => channel.name === channelName)).toBe(true);

      await openSettingsSection(page, "Роли");
      const higherRow = page.locator(`[data-role-id="${higherRoleId}"]`);
      await higherRow.getByRole("button", { name: "Выше" }).click();
      await expect(page.getByText("Порядок ролей изменён.", { exact: true })).toBeVisible();

      const afterResponse = await readerSession.context.request.get("/api/channels", { failOnStatusCode: false });
      expect(afterResponse.status()).toBe(200);
      const after = await afterResponse.json() as { channels: Array<{ id: string; name: string }> };
      expect(after.channels).toEqual(before.channels);
    } finally {
      await delegateSession?.context.close();
      await employeeSession?.context.close();
      await readerSession?.context.close();
    }
  }, 120_000);
});
