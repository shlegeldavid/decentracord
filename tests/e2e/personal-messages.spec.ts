import { randomBytes } from "node:crypto";
import { applicationOrigin, expect, test } from "./fixtures.js";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

async function login(page: Page, credentials: { login: string; password: string }): Promise<void> {
  await page.goto(`${applicationOrigin}/`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill(credentials.login);
  await page.getByLabel("Пароль").fill(credentials.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
}

async function newAuthenticatedPage(
  browser: Browser,
  credentials: { login: string; password: string }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: applicationOrigin });
  const page = await context.newPage();
  try {
    await login(page, credentials);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function startConversationWith(page: Page, login: string): Promise<void> {
  const section = page.locator(".dm-section");
  await section.getByRole("button", { name: "Начать переписку" }).click();
  const dialog = page.getByRole("dialog", { name: "Новая переписка" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Поиск участников" });
  await search.fill(login);
  const result = dialog.locator(".dm-picker-result").filter({ hasText: login });
  await expect(result).toBeVisible();
  await result.click();
  await dialog.getByRole("button", { name: "Начать переписку" }).click();
  await expect(dialog).toHaveCount(0);
}

function messageRow(page: Page, text: string) {
  return page.locator(".message-feed .message-row").filter({ hasText: text });
}

// Групповая переписка: модалка «Новая переписка» открывается в разделе, чипов
// должно быть больше одного — один чип сервер считает перепиской на двоих.
async function startGroupWith(page: Page, logins: string[]): Promise<void> {
  const section = page.locator(".dm-section");
  await section.getByRole("button", { name: "Начать переписку" }).click();
  const dialog = page.getByRole("dialog", { name: "Новая переписка" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Поиск участников" });
  for (const login of logins) {
    await search.fill(login);
    const result = dialog.locator(".dm-picker-result").filter({ hasText: login });
    await expect(result).toBeVisible();
    await result.click();
    await expect(dialog.locator(".dm-picker-selected")).toContainText(login);
  }
  await dialog.getByRole("button", { name: "Начать переписку" }).click();
  await expect(dialog).toHaveCount(0);
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel("Сообщение").fill(text);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
}

async function issueCsrf(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/auth/csrf");
  expect(response.status()).toBe(200);
  const body = await response.json() as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe("string");
  return body.csrfToken as string;
}

// Отключение участника через API администратора: настройки уже покрыты
// отдельным набором, здесь важно только следствие для переписки.
async function disableMemberByLogin(context: BrowserContext, loginValue: string): Promise<void> {
  const token = await issueCsrf(context.request);
  const membersResponse = await context.request.get("/api/members");
  expect(membersResponse.status()).toBe(200);
  const members = await membersResponse.json() as { members: Array<{ id: string; login: string }> };
  const member = members.members.find((entry) => entry.login === loginValue);
  if (!member) throw new Error(`Member ${loginValue} was not found`);
  const response = await context.request.post(`/api/members/${member.id}/disable`, {
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
  expect(response.status()).toBe(204);
}

// Третий и четвёртый участник создаются администратором: в сиде только два
// логина. Пароль не нужен — эти участники в браузере не входят.
async function createMemberByLogin(context: BrowserContext, loginValue: string): Promise<void> {
  const token = await issueCsrf(context.request);
  const response = await context.request.post(`/api/members`, {
    data: { login: loginValue, password: `E2E-added-${randomBytes(18).toString("base64url")}` },
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
  expect(response.status(), await response.text()).toBe(201);
}

// Идентификатор нужен, чтобы начать переписку штатным API: в списке
// получателей пересылки должна быть вторая переписка, кроме источника.
async function createMemberReturningId(context: BrowserContext, loginValue: string): Promise<string> {
  const token = await issueCsrf(context.request);
  const response = await context.request.post(`/api/members`, {
    data: { login: loginValue, password: `E2E-added-${randomBytes(18).toString("base64url")}` },
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
  const text = await response.text();
  expect(response.status(), text).toBe(201);
  return (JSON.parse(text) as { id: string }).id;
}

async function createConversationViaApi(context: BrowserContext, participantId: string): Promise<void> {
  const token = await issueCsrf(context.request);
  const response = await context.request.post("/api/conversations", {
    data: { participantIds: [participantId] },
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
  expect(response.status(), await response.text()).toBe(201);
}

interface ChannelSummary {
  id: string;
  name: string;
}

// Канал-получатель создаётся до входа участников: иначе он не попадёт в их
// список каналов без перезагрузки, а диалог пересылки берёт каналы оттуда.
async function createSendableChannelViaApi(context: BrowserContext, name: string): Promise<ChannelSummary> {
  const token = await issueCsrf(context.request);
  const response = await context.request.post("/api/channels", {
    data: {
      name,
      overrides: [
        { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
        { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
      ]
    },
    headers: { origin: applicationOrigin, "x-csrf-token": token }
  });
  const text = await response.text();
  expect(response.status(), text).toBe(201);
  return JSON.parse(text) as ChannelSummary;
}

async function selectChannel(page: Page, channel: ChannelSummary): Promise<void> {
  const row = page.locator(`.channel-list[data-scope="workspace"] [data-channel-id="${channel.id}"]`);
  await expect(row).toBeVisible();
  await row.locator(".channel-list-select").click();
  await expect(page.getByRole("heading", { level: 2, name: channel.name })).toBeVisible();
  await expect(page.locator(".message-feed")).toBeVisible();
}

async function openForwardDialog(page: Page, text: string) {
  await messageRow(page, text).click({ button: "right" });
  const forwardItem = page.getByRole("menuitem", { name: "Переслать", exact: true })
    .within(page.locator(".context-menu"));
  await expect(forwardItem).toBeVisible();
  await forwardItem.click();
  const dialog = page.getByRole("dialog", { name: "Переслать сообщение" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("personal messages in the sidebar", () => {
  test("starts a conversation from the section and from the participant card", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const colleague = messagingSeed.manager.login;
    try {
      const section = member.page.locator(".dm-section");
      await expect(section).toBeVisible();
      await expect(section.getByText("Личные сообщения", { exact: true })).toBeVisible();

      // Раздел стоит над списком каналов: обе части прокручиваются одной областью.
      const sectionBox = await section.boundingBox();
      const channelListBox = await member.page.locator(".channel-list[data-scope=\"workspace\"]").boundingBox();
      if (!sectionBox || !channelListBox) throw new Error("Sidebar layout was not measured");
      expect(sectionBox.y).toBeLessThan(channelListBox.y);

      const startButton = section.getByRole("button", { name: "Начать переписку" });
      await expect(startButton).toBeVisible();
      await startButton.click();

      const dialog = member.page.getByRole("dialog", { name: "Новая переписка" });
      await expect(dialog).toBeVisible();
      const search = dialog.getByRole("searchbox", { name: "Поиск участников" });
      await expect(search).toBeFocused();
      await search.fill(colleague);

      const result = dialog.locator(".dm-picker-result").filter({ hasText: colleague });
      await expect(result).toBeVisible();
      await result.click();
      await expect(dialog.locator(".dm-picker-selected")).toContainText(colleague);
      await dialog.getByRole("button", { name: "Начать переписку" }).click();
      await expect(dialog).toHaveCount(0);

      await expect(section.locator(".dm-row")).toHaveCount(1);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(colleague);
      await expect(member.page.getByText("Это начало переписки — напишите первое")).toBeVisible();
      await expect(member.page.getByText("Отправьте первое сообщение — его увидит собеседник.")).toBeVisible();

      // Второй путь: кнопка «Написать сообщение» в карточке участника.
      const peopleField = member.page.getByRole("combobox", { name: "Поиск людей" });
      await peopleField.fill(colleague);
      const peopleList = member.page.getByRole("listbox", { name: "Результаты поиска людей" });
      await expect(peopleList.getByRole("option", { name: colleague })).toBeVisible();
      await peopleField.press("ArrowDown");
      await peopleField.press("Enter");

      const card = member.page.locator(".people-search-card");
      const messageButton = card.getByRole("button", { name: "Написать сообщение" });
      await expect(messageButton).not.toHaveAttribute("aria-disabled", "true");
      await messageButton.click();

      // Переписка с этим человеком уже есть: второй строки не появляется.
      await expect(section.locator(".dm-row")).toHaveCount(1);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(colleague);
      await expect(member.page.locator(".dm-row-select[aria-current=\"true\"]")).toHaveCount(1);

      // Свёрнутость раздела и её сохранение между перезагрузками.
      await member.page.getByRole("button", { name: "Свернуть личные сообщения" }).click();
      await expect(section.locator(".dm-list")).toHaveCount(0);
      await expect(
        section.getByRole("button", { name: "Развернуть личные сообщения" })
      ).toHaveAttribute("aria-expanded", "false");
      // Непрочитанных нет, поэтому счётчик раздела не рендерится.
      await expect(section.locator(".channel-category-badge")).toHaveCount(0);

      await member.page.reload();
      await expect(member.page.locator(".app-shell")).toBeVisible();
      await expect(
        member.page.getByRole("button", { name: "Развернуть личные сообщения" })
      ).toHaveAttribute("aria-expanded", "false");
      await expect(member.page.locator(".dm-list")).toHaveCount(0);
      const storedCollapsed = await member.page.evaluate(
        () => window.localStorage.getItem("decentracord:sidebar-collapsed-direct-messages")
      );
      expect(storedCollapsed).toBe("true");
    } finally {
      await member.context.close();
    }
  });

  test("delivers a conversation message to the peer without reload and marks delivery for the author", async ({ browser, messagingSeed }) => {
    const author = await newAuthenticatedPage(browser, messagingSeed.member);
    const peerLogin = messagingSeed.manager.login;
    const firstMessage = "Привет, это личное сообщение";
    const catchUpMessage = "Второе сообщение после обрыва связи";
    try {
      await startConversationWith(author.page, peerLogin);
      await expect(author.page.locator(".chat-pane-header h2")).toHaveText(peerLogin);

      const peer = await newAuthenticatedPage(browser, messagingSeed.manager);
      try {
        const row = peer.page.locator(".dm-section .dm-row").filter({ hasText: messagingSeed.member.login });
        await expect(row).toHaveCount(1);
        await row.locator(".dm-row-select").click();
        await expect(peer.page.locator(".chat-pane-header h2")).toHaveText(messagingSeed.member.login);
        await expect(peer.page.locator(".message-feed")).toBeVisible();

        await sendMessage(author.page, firstMessage);
        const ownRow = messageRow(author.page, firstMessage);
        await expect(ownRow).toHaveCount(1);
        // У автора — одна галочка «Доставлено на сервер».
        await expect(ownRow.locator(".message-delivery")).toHaveCount(1);
        await expect(ownRow.locator(".message-delivery")).toHaveAttribute("title", "Доставлено на сервер");
        await expect(ownRow.locator(".message-delivery")).toHaveAttribute("role", "img");

        // Собеседник видит сообщение без перезагрузки.
        await expect(peer.page.getByText(firstMessage)).toBeVisible({ timeout: 5_000 });
        await expect(peer.page.locator(".message-delivery")).toHaveCount(0);

        // Обрыв связи и догон по updated_seq: сообщение появляется ровно один раз.
        await peer.context.setOffline(true);
        await expect(peer.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
        await sendMessage(author.page, catchUpMessage);
        await expect(peer.page.getByText(catchUpMessage)).toHaveCount(0, { timeout: 500 });
        await peer.context.setOffline(false);
        await expect(peer.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
        await expect(peer.page.getByText(catchUpMessage)).toHaveCount(1, { timeout: 10_000 });
        await expect(peer.page.locator(".message-feed [data-message-id]").filter({ hasText: catchUpMessage }))
          .toHaveAttribute("data-message-id", /.+/u);

        // Меню своего сообщения переписки: правит и удаляет только автор
        //, «Кто прочитал» и закрепления отсутствуют.
        await ownRow.click({ button: "right" });
        const menu = author.page.locator(".context-menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Копировать текст" })).toHaveCount(1);
        await expect(menu.getByRole("menuitem", { name: "Править" })).toHaveCount(1);
        await expect(menu.getByRole("menuitem", { name: "Удалить" })).toHaveCount(1);
        await expect(menu.getByRole("menuitem", { name: "Переслать" })).toHaveCount(1);
        await expect(menu.getByRole("menuitem", { name: "Кто прочитал" })).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: "Закрепить" })).toHaveCount(0);
        await author.page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
      } finally {
        await peer.context.close();
      }
    } finally {
      await author.context.close();
    }
  });

  test("shows the unread badge and the tab title and clears them after opening the conversation", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const peerLogin = messagingSeed.manager.login;
    try {
      await startConversationWith(member.page, peerLogin);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(peerLogin);

      // Открытая переписка помечается прочитанной. Файл переиспользует одну пару
      // участников, поэтому базовый заголовок запоминаем, а не считаем нулевым.
      const memberRow = member.page.locator(".dm-section .dm-row").filter({ hasText: peerLogin });
      await expect(memberRow).toHaveCount(1);
      await expect(memberRow.locator(".unread-badge")).toHaveCount(0);

      // Перезагрузка снимает выбор: переписка остаётся строкой списка.
      await member.page.reload();
      await expect(member.page.locator(".app-shell")).toBeVisible();
      const row = member.page.locator(".dm-section .dm-row").filter({ hasText: peerLogin });
      await expect(row).toHaveCount(1);
      const conversationId = await row.getAttribute("data-dm-id");
      if (!conversationId) throw new Error("Conversation row has no identifier");
      const titleWithoutUnread = await member.page.title();

      const peer = await newAuthenticatedPage(browser, messagingSeed.manager);
      try {
        await peer.page.locator(`[data-dm-id="${conversationId}"] .dm-row-select`).click();
        await sendMessage(peer.page, "Привет без прочтения");

        // счётчик строки и число в заголовке появляются без перезагрузки.
        // Область ограничена строкой, иначе strict mode violation.
        const badge = member.page.locator(`[data-dm-id="${conversationId}"] .unread-badge`);
        await expect(badge).toHaveText(/\d+/u, { timeout: 10_000 });
        await expect(member.page).toHaveTitle(/^\(\d+\+?\) Decentracord$/u);

        // Открытие переписки сбрасывает счётчик и заголовок.
        await member.page.locator(`[data-dm-id="${conversationId}"] .dm-row-select`).click();
        await expect(member.page.locator(`[data-dm-id="${conversationId}"] .unread-badge`)).toHaveCount(0);
        await expect(member.page).toHaveTitle(titleWithoutUnread);

        // Курсор сохранён на сервере: после перезагрузки бейджа нет.
        await member.page.reload();
        await expect(member.page.locator(`[data-dm-id="${conversationId}"] .dm-row-select`)).toBeVisible();
        await expect(member.page.locator(`[data-dm-id="${conversationId}"] .unread-badge`)).toHaveCount(0);
      } finally {
        await peer.context.close();
      }
    } finally {
      await member.context.close();
    }
  });

  test("closes a conversation from the row menu and returns it on a new message", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const peerLogin = messagingSeed.manager.login;
    const firstMessage = "Сообщение перед закрытием";
    try {
      await startConversationWith(member.page, peerLogin);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(peerLogin);
      await sendMessage(member.page, firstMessage);
      await expect(messageRow(member.page, firstMessage)).toHaveCount(1);

      const row = member.page.locator(".dm-section .dm-row").filter({ hasText: peerLogin });
      const conversationId = await row.getAttribute("data-dm-id");
      if (!conversationId) throw new Error("Conversation row has no identifier");

      // Контекстное меню строки: единственный пункт «Закрыть переписку».
      await member.page.locator(`[data-dm-id="${conversationId}"] .dm-row-select`).click({ button: "right" });
      const menuItem = member.page.getByRole("menuitem", { name: "Закрыть переписку" });
      await expect(menuItem).toBeVisible();
      await menuItem.click();

      await expect(member.page.locator(`[data-dm-id="${conversationId}"]`)).toHaveCount(0);
      await expect(
        member.page.locator(".chat-pane .visually-hidden[aria-live='polite']").filter({ hasText: "Переписка закрыта." })
      ).toHaveCount(1);
      // Открытая переписка закрылась: лента вернулась к пустому состоянию выбора.
      await expect(member.page.getByText("Выберите канал слева, чтобы открыть переписку.")).toBeVisible();

      const peer = await newAuthenticatedPage(browser, messagingSeed.manager);
      try {
        await peer.page.locator(`[data-dm-id="${conversationId}"] .dm-row-select`).click();
        await sendMessage(peer.page, "Новое сообщение после закрытия");
        await expect(messageRow(peer.page, "Новое сообщение после закрытия")).toHaveCount(1);
        // Строка возвращается без перезагрузки: сервер снял closed_at.
        await expect(member.page.locator(`[data-dm-id="${conversationId}"]`)).toHaveCount(1, { timeout: 10_000 });
      } finally {
        await peer.context.close();
      }
    } finally {
      await member.context.close();
    }
  });

  test("hides the open conversation when the peer is disabled and keeps its messages", async ({ browser, identity, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const peerLogin = messagingSeed.manager.login;
    const admin = await newAuthenticatedPage(browser, identity.admin);
    const hiddenMessage = "Сообщение до отключения";
    try {
      await startConversationWith(member.page, peerLogin);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(peerLogin);
      await sendMessage(member.page, hiddenMessage);
      await expect(messageRow(member.page, hiddenMessage)).toHaveCount(1);

      await disableMemberByLogin(admin.context, peerLogin);

      // карточка появляется без перезагрузки, сообщения остаются на экране.
      const card = member.page.locator(".revoked-access-card");
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.locator("h3")).toHaveText("Переписка скрыта");
      await expect(card.locator(".revoked-access-reason")).toHaveText("Один из участников отключён.");
      await expect(card).toContainText("История сохранится и вернётся, когда участника снова включат.");
      await expect(messageRow(member.page, hiddenMessage)).toHaveCount(1);
      await expect(member.page.locator(".dm-section .dm-row").filter({ hasText: peerLogin })).toHaveCount(0);

      await card.getByRole("button", { name: "К списку переписок" }).click();
      await expect(card).toHaveCount(0);
    } finally {
      await admin.context.close();
      await member.context.close();
    }
  });

  test("manages group membership, the add right and the history flag", async ({ browser, identity, messagingSeed }) => {
    const suffix = randomBytes(6).toString("hex");
    const thirdLogin = `dm-third-${suffix}`;
    const fourthLogin = `dm-fourth-${suffix}`;
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    const admin = await newAuthenticatedPage(browser, identity.admin);
    try {
      await createMemberByLogin(admin.context, thirdLogin);
      await createMemberByLogin(admin.context, fourthLogin);

      // Группа: создатель и двое приглашённых — один чип даёт переписку на двоих.
      await startGroupWith(manager.page, [messagingSeed.member.login, thirdLogin]);
      await expect(manager.page.locator(".chat-pane-header h2")).toContainText(messagingSeed.member.login);

      const panel = manager.page.locator(".member-panel");
      await expect(panel.getByRole("heading", { name: "Участники переписки" })).toBeVisible();
      const rows = panel.locator(".dm-member-row");
      await expect(rows).toHaveCount(3);
      // Подпись «вы» стоит только у собственной строки.
      await expect(rows.filter({ hasText: messagingSeed.manager.login })).toContainText("вы");
      await expect(rows.filter({ hasText: messagingSeed.member.login })).not.toContainText("вы");
      await expect(panel.getByRole("button", { name: "Добавить участника" })).toBeVisible();

      // Создатель выдаёт право добавлять.
      const grant = rows.filter({ hasText: messagingSeed.member.login })
        .getByRole("button", { name: "Право добавлять участников" });
      await expect(grant).toHaveAttribute("aria-pressed", "false");
      await grant.click();
      await expect(grant).toHaveAttribute("aria-pressed", "true");

      const member = await newAuthenticatedPage(browser, messagingSeed.member);
      try {
        const memberRow = member.page.locator(".dm-section .dm-row");
        await expect(memberRow).toHaveCount(1);
        await memberRow.locator(".dm-row-select").click();
        const memberPanel = member.page.locator(".member-panel");
        await expect(memberPanel.getByRole("heading", { name: "Участники переписки" })).toBeVisible();
        // Носитель права управляет составом, но переключателя у него нет.
        await expect(memberPanel.getByRole("button", { name: "Добавить участника" })).toBeVisible();
        await expect(memberPanel.getByRole("button", { name: "Право добавлять участников" })).toHaveCount(0);

        await memberPanel.getByRole("button", { name: "Добавить участника" }).click();
        const addDialog = member.page.getByRole("dialog", { name: "Добавить участников" });
        await expect(addDialog).toBeVisible();
        const search = addDialog.getByRole("searchbox", { name: "Поиск участников" });
        await search.fill(fourthLogin);
        const found = addDialog.locator(".dm-picker-result").filter({ hasText: fourthLogin });
        await expect(found).toBeVisible();
        await found.click();

        // Флажок истории включён по умолчанию и персональный.
        const historyFlag = addDialog.getByRole("checkbox", { name: "Показать историю" });
        await expect(historyFlag).toBeChecked();
        await historyFlag.uncheck();
        await expect(addDialog.getByText("Снятый флажок скрывает от участника сообщения, отправленные до его добавления."))
          .toBeVisible();
        await addDialog.getByRole("button", { name: "Добавить участников" }).click();
        await expect(addDialog).toHaveCount(0);

        await expect(memberPanel.locator(".dm-member-row")).toHaveCount(4);
        await expect(
          member.page.locator(".chat-pane .visually-hidden[aria-live='polite']").filter({ hasText: "Участники добавлены." })
        ).toHaveCount(1);

        // Удаление участника: сообщения остаются, строка исчезает.
        await memberPanel.locator(".dm-member-row").filter({ hasText: fourthLogin })
          .getByRole("button", { name: `Убрать ${fourthLogin} из переписки` })
          .click();
        await expect(memberPanel.locator(".dm-member-row")).toHaveCount(3);
        await expect(memberPanel.getByText(`${fourthLogin} убран из переписки.`)).toHaveCount(1);
      } finally {
        await member.context.close();
      }

      // Переписку на двоих расширить нельзя: кнопок управления составом нет.
      await startConversationWith(manager.page, messagingSeed.member.login);
      const directPanel = manager.page.locator(".member-panel");
      await expect(directPanel.getByRole("heading", { name: "Участники переписки" })).toBeVisible();
      await expect(directPanel.getByRole("button", { name: "Добавить участника" })).toHaveCount(0);
      await expect(directPanel.getByRole("button", { name: "Право добавлять участников" })).toHaveCount(0);
      await expect(directPanel.getByRole("button", { name: /^Убрать .+ из переписки$/u })).toHaveCount(0);
    } finally {
      await admin.context.close();
      await manager.context.close();
    }
  });

  test("shows the typing indicator over the composer and in the list and drops it on expiry and disconnect", async ({ browser, messagingSeed }) => {
    // Сценарий намеренно длинный: гашение через 10 с, повторный набор и обрыв
    // связи не помещаются в общий лимит.
    test.setTimeout(150_000);
    const author = await newAuthenticatedPage(browser, messagingSeed.member);
    const peerLogin = messagingSeed.manager.login;
    const composer = author.page.getByLabel("Сообщение");
    try {
      await startConversationWith(author.page, peerLogin);
      await expect(author.page.locator(".chat-pane-header h2")).toHaveText(peerLogin);

      const peer = await newAuthenticatedPage(browser, messagingSeed.manager);
      try {
        const peerSection = peer.page.locator(".dm-section");
        const peerRow = peerSection.locator(".dm-row").filter({ hasText: messagingSeed.member.login });
        await expect(peerRow).toHaveCount(1);

        // Набор по одному символу: `fill` не вызывает обработчик на каждый символ.
        await composer.pressSequentially("Привет", { delay: 60 });

        // кольцо-пульс в списке диалогов, хотя переписка у собеседника не открыта.
        await expect(peerRow.locator(".dm-row-avatar.is-typing")).toHaveCount(1, { timeout: 5_000 });

        await peerRow.locator(".dm-row-select").click();
        const indicator = peer.page.locator(".chat-pane .typing-indicator");
        // Строка над композером показывает логин собеседника.
        await expect(indicator).toHaveText(new RegExp(`^${messagingSeed.member.login} печатает…$`, "u"), { timeout: 5_000 });

        // через 10 с без символов строка гаснет, кольцо пропадает.
        await expect(indicator).toHaveText("", { timeout: 15_000 });
        await expect(peerRow.locator(".dm-row-avatar.is-typing")).toHaveCount(0);

        // набор виден снова, но разрыв связи гасит его сразу.
        await composer.pressSequentially("Ещё", { delay: 60 });
        await expect(indicator).toHaveText(/печатает…/u, { timeout: 5_000 });
        await expect(peerRow.locator(".dm-row-avatar.is-typing")).toHaveCount(1);

        await peer.context.setOffline(true);
        await expect(peer.page.locator(".connection-status")).toContainText("нет связи", { timeout: 15_000 });
        await expect(indicator).toHaveText("", { timeout: 5_000 });
        await expect(peerRow.locator(".dm-row-avatar.is-typing")).toHaveCount(0);

        await peer.context.setOffline(false);
        await expect(peer.page.locator(".connection-status")).toContainText("подключено", { timeout: 15_000 });
        // Без нового набора карта не восстанавливается: сервер состояние не хранит.
        await peer.page.waitForTimeout(3_000);
        await expect(indicator).toHaveText("");
        await expect(peerRow.locator(".dm-row-avatar.is-typing")).toHaveCount(0);

        // в правой панели «Участники переписки» индикатора нет ни строкой, ни кольцом.
        await composer.pressSequentially("Проверка", { delay: 60 });
        await expect(indicator).toHaveText(/печатает…/u, { timeout: 5_000 });
        const memberPanel = peer.page.locator(".member-panel");
        await expect(memberPanel.getByRole("heading", { name: "Участники переписки" })).toBeVisible();
        await expect(memberPanel.locator(".typing-indicator")).toHaveCount(0);
        await expect(memberPanel.locator(".is-typing")).toHaveCount(0);
      } finally {
        await peer.context.close();
      }
    } finally {
      await author.context.close();
    }
  });

  test("edits, deletes and forwards a conversation message in both directions", async ({ browser, identity, messagingSeed }) => {
    // Сценарий длинный: правка, удаление и две пересылки с проверкой лент.
    test.setTimeout(240_000);
    const suffix = randomBytes(6).toString("hex");
    const extraLogin = `dm-extra-${suffix}`;
    const originalText = "Исходное сообщение переписки";
    const editedText = "Изменённое сообщение переписки";
    const peerText = "Ответ собеседника в переписке";
    const channelText = "Сообщение из канала";
    const admin = await newAuthenticatedPage(browser, identity.admin);
    // Канал создаётся до входа участников: он должен попасть в их список.
    const targetChannel = await createSendableChannelViaApi(admin.context, `dm-forward-${suffix}`);
    const extraId = await createMemberReturningId(admin.context, extraLogin);
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    const manager = await newAuthenticatedPage(browser, messagingSeed.manager);
    try {
      // Вторая переписка участника: группа «Личные сообщения» должна быть
      // непустой, потому что переписка-источник из списка исключается.
      await createConversationViaApi(member.context, extraId);

      await startConversationWith(member.page, messagingSeed.manager.login);
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(messagingSeed.manager.login);
      await sendMessage(member.page, originalText);
      await expect(messageRow(member.page, originalText)).toHaveCount(1);

      // Ответ собеседника: у чужого сообщения в меню только копирование и пересылка.
      const managerRow = manager.page.locator(".dm-section .dm-row").filter({ hasText: messagingSeed.member.login });
      await expect(managerRow).toHaveCount(1);
      await managerRow.locator(".dm-row-select").click();
      await expect(manager.page.locator(".chat-pane-header h2")).toHaveText(messagingSeed.member.login);
      await sendMessage(manager.page, peerText);
      await expect(member.page.getByText(peerText)).toBeVisible({ timeout: 10_000 });

      await messageRow(member.page, peerText).click({ button: "right" });
      const peerMenu = member.page.locator(".context-menu");
      await expect(peerMenu).toBeVisible();
      await expect(peerMenu.getByRole("menuitem", { name: "Копировать текст" })).toHaveCount(1);
      await expect(peerMenu.getByRole("menuitem", { name: "Переслать" })).toHaveCount(1);
      await expect(peerMenu.getByRole("menuitem", { name: "Править" })).toHaveCount(0);
      await expect(peerMenu.getByRole("menuitem", { name: "Удалить" })).toHaveCount(0);
      await expect(peerMenu.getByRole("menuitem", { name: "Кто прочитал" })).toHaveCount(0);
      await expect(peerMenu.getByRole("menuitem", { name: "Закрепить" })).toHaveCount(0);
      await member.page.keyboard.press("Escape");
      await expect(peerMenu).toHaveCount(0);

      // Правка своего сообщения: новый текст и пометка «изменено».
      await messageRow(member.page, originalText).click({ button: "right" });
      const ownMenu = member.page.locator(".context-menu");
      await expect(ownMenu.getByRole("menuitem", { name: "Править" })).toHaveCount(1);
      await ownMenu.getByRole("menuitem", { name: "Править" }).click();
      const editor = member.page.getByLabel("Изменить сообщение");
      await expect(editor).toBeVisible();
      await editor.fill(editedText);
      await member.page.getByRole("button", { name: "Сохранить", exact: true }).click();
      const editedRow = messageRow(member.page, editedText);
      await expect(editedRow).toHaveCount(1);
      await expect(editedRow.locator(".message-edited")).toHaveText("изменено");
      await expect(messageRow(member.page, originalText)).toHaveCount(0);

      // Пересылка из переписки в канал: «Личные сообщения» идут первой группой,
      // источник исключён, логин оригинала — текст, а не ссылка.
      const conversationDialog = await openForwardDialog(member.page, editedText);
      await expect(conversationDialog.locator("[data-forward-group]").first())
        .toHaveAttribute("data-forward-group", "Личные сообщения");
      await expect(conversationDialog.getByRole("option", { name: extraLogin, exact: true })).toHaveCount(1);
      await expect(conversationDialog.getByRole("option", { name: messagingSeed.manager.login, exact: true })).toHaveCount(0);
      await conversationDialog.getByRole("option", { name: targetChannel.name, exact: true }).click();
      await expect(conversationDialog.getByRole("button", { name: "Переслать", exact: true })).toBeEnabled();
      await conversationDialog.getByRole("button", { name: "Переслать", exact: true }).click();
      await expect(conversationDialog).toHaveCount(0);

      await selectChannel(member.page, targetChannel);
      const forwardedToChannel = messageRow(member.page, editedText);
      await expect(forwardedToChannel).toHaveCount(1);
      const forwardedBlock = forwardedToChannel.locator(".forwarded-block");
      await expect(forwardedBlock).toHaveCount(1);
      await expect(forwardedBlock).toContainText(`Переслано от ${messagingSeed.member.login}`);
      await expect(forwardedBlock.locator(".forwarded-author")).toBeVisible();
      await expect(forwardedBlock.locator("a")).toHaveCount(0);
      await expect(forwardedBlock.locator("button.forwarded-author")).toHaveCount(0);

      // Пересылка из канала в переписку: пометка автора оригинала в ленте переписки.
      await selectChannel(manager.page, targetChannel);
      await sendMessage(manager.page, channelText);
      await expect(messageRow(manager.page, channelText)).toHaveCount(1);
      const channelDialog = await openForwardDialog(manager.page, channelText);
      await expect(channelDialog.locator("[data-forward-group]").first())
        .toHaveAttribute("data-forward-group", "Личные сообщения");
      await channelDialog.getByRole("option", { name: messagingSeed.member.login, exact: true }).click();
      await channelDialog.getByRole("button", { name: "Переслать", exact: true }).click();
      await expect(channelDialog).toHaveCount(0);

      await member.page.locator(".dm-section .dm-row").filter({ hasText: messagingSeed.manager.login })
        .locator(".dm-row-select").click();
      await expect(member.page.locator(".chat-pane-header h2")).toHaveText(messagingSeed.manager.login);
      const forwardedToConversation = messageRow(member.page, channelText);
      await expect(forwardedToConversation).toHaveCount(1, { timeout: 10_000 });
      await expect(forwardedToConversation.locator(".forwarded-block"))
        .toContainText(`Переслано от ${messagingSeed.manager.login}`);

      // Удаление своего сообщения: tombstone вместо текста.
      await messageRow(member.page, editedText).click({ button: "right" });
      const deleteMenu = member.page.locator(".context-menu");
      await expect(deleteMenu.getByRole("menuitem", { name: "Удалить" })).toHaveCount(1);
      await deleteMenu.getByRole("menuitem", { name: "Удалить" }).click();
      await expect(member.page.locator(".message-feed .message-row-deleted .message-body")).toHaveText("Сообщение удалено");
      await expect(messageRow(member.page, editedText)).toHaveCount(0);
    } finally {
      await Promise.all([member.context.close(), manager.context.close(), admin.context.close()]);
    }
  });

  test("keeps the personal messages section after the app and database restart @session-after-restart", async ({ browser, messagingSeed }) => {
    const member = await newAuthenticatedPage(browser, messagingSeed.member);
    try {
      const section = member.page.locator(".dm-section");
      await expect(section).toBeVisible();
      await expect(section.getByRole("button", { name: "Начать переписку" })).toBeVisible();
      // Список переписок приходит с сервера уже после перезапуска: раздел не в
      // состоянии ошибки.
      await expect(member.page.getByText("Не удалось загрузить переписки.")).toHaveCount(0);
      await member.page.getByRole("button", { name: "Свернуть личные сообщения" }).click();
      await expect(section.locator(".dm-list")).toHaveCount(0);
      await expect(
        section.getByRole("button", { name: "Развернуть личные сообщения" })
      ).toHaveAttribute("aria-expanded", "false");
    } finally {
      await member.context.close();
    }
  });
});
