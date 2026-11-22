import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  changePassword,
  getConversationMessages,
  getCurrentUser,
  getMessages,
  login,
  logout,
  uploadOrganizationLogo
} from "../../apps/web/src/api.js";

const csrfToken = "a".repeat(32);
const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("web API", () => {
  it("sends the login body and CSRF header with same-origin credentials", async () => {
    const credentials = { login: "alice", password: "test-password" };
    const nextToken = "b".repeat(32);
    fetchMock.mockResolvedValueOnce(json({ csrfToken: nextToken }));

    await expect(login(credentials, csrfToken)).resolves.toBe(nextToken);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      }),
      body: JSON.stringify(credentials)
    });
  });

  it("preserves HTTP errors on JSON and no-content routes", async () => {
    const credentials = { currentPassword: "old-password", newPassword: "new-password" };
    fetchMock
      .mockImplementationOnce(async () => json({ error: { code: "UNAUTHORIZED", message: "Сессия истекла" } }, 401))
      .mockImplementationOnce(async () => json({ error: { code: "FORBIDDEN", message: "x".repeat(161) } }, 403));

    const unauthorized = getCurrentUser();
    await expect(unauthorized).rejects.toBeInstanceOf(ApiError);
    await expect(unauthorized).rejects.toMatchObject({
      status: 401, code: "UNAUTHORIZED", message: "Сессия истекла"
    });
    await expect(changePassword(credentials, csrfToken)).rejects.toMatchObject({
      status: 403, code: "FORBIDDEN", message: "Не удалось выполнить запрос"
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/password", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify(credentials)
    });
  });

  it("requires a 204 response for logout", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({}));

    await expect(logout(csrfToken)).resolves.toBeUndefined();
    await expect(logout(csrfToken)).rejects.toMatchObject({
      status: 502, code: "INVALID_RESPONSE", message: "Сервер вернул некорректный ответ при выходе"
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", "x-csrf-token": csrfToken }
    });
  });

  it("encodes channel and conversation history queries and rejects invalid pages", async () => {
    const page = { messages: [], hasMore: false, cursor: 19 };
    fetchMock.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ ...page, messages: [{}] }));

    await expect(getMessages("channel /", { before: 0, limit: 20 })).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/channels/channel%20%2F/messages?before=0&limit=20", expect.anything()
    );
    await expect(getConversationMessages("dm/?", { after: 7 })).rejects.toMatchObject({
      status: 502, code: "INVALID_RESPONSE", message: "Сервер вернул некорректные данные истории переписки"
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/conversations/dm%2F%3F/messages?after=7&limit=50", expect.anything()
    );
    fetchMock.mockClear();
    await expect(getMessages("channel", { before: 0, after: 1 })).rejects.toMatchObject({
      status: 400, code: "INVALID_REQUEST"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads the logo as the original PNG file", async () => {
    const file = new File([Uint8Array.of(137, 80, 78, 71)], "logo.png", { type: "image/png" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(uploadOrganizationLogo(file, csrfToken)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/organization/logo", {
      method: "PUT",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "image/png", "content-type": "image/png", "x-csrf-token": csrfToken },
      body: file
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(file);
  });
});
