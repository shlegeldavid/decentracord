import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./icons";

interface LoginScreenProps {
  loading: boolean;
  loginValue: string;
  onLoginChange: (value: string) => void;
  onSubmit: (password: string) => Promise<void>;
  isSubmitting: boolean;
  canSubmit: boolean;
  errorMessage: string | null;
  successMessage: string | null;
}

export function LoginScreen({
  loading,
  loginValue,
  onLoginChange,
  onSubmit,
  isSubmitting,
  canSubmit,
  errorMessage,
  successMessage
}: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const loginInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading) loginInput.current?.focus();
  }, [loading]);

  if (loading) {
    return (
      <main className="page-shell">
        <section className="status-card" aria-live="polite">
          <span className="brand-mark" aria-hidden="true">D</span>
          <p className="eyebrow">DECENTRACORD</p>
          <p role="status" className="loading-copy">Проверяем доступ…</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-row login-brand">
          <LogoMark size={40} className="brand-mark" />
          <span className="brand-name">Decentracord</span>
        </div>
        <p className="eyebrow">ЗАКРЫТАЯ ОРГАНИЗАЦИЯ</p>
        <h1 id="login-title">Вход</h1>
        <p className="intro-copy">Войдите с данными, выданными администратором.</p>

        {successMessage && <p className="form-success" aria-live="polite">{successMessage}</p>}
        {errorMessage && <p className="form-error" id="login-error" role="alert">{errorMessage}</p>}

        <form onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(password);
        }} aria-busy={isSubmitting}>
          <label htmlFor="login">Логин</label>
          <input
            autoComplete="username"
            autoCapitalize="none"
            id="login"
            name="login"
            ref={loginInput}
            required
            value={loginValue}
            onChange={(event) => onLoginChange(event.currentTarget.value)}
            aria-describedby={errorMessage ? "login-error" : undefined}
          />

          <label htmlFor="password">Пароль</label>
          <input
            autoComplete="current-password"
            id="password"
            name="password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            aria-describedby={errorMessage ? "login-error" : undefined}
          />

          <button type="submit" disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? "Входим…" : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}
