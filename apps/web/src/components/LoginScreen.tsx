import type { FormEvent, RefObject } from "react";
import { LogoMark } from "./icons";

interface LoginScreenProps {
  loginValue: string;
  passwordValue: string;
  onLoginChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  loginInputRef: RefObject<HTMLInputElement | null>;
  isSubmitting: boolean;
  canSubmit: boolean;
  errorMessage: string | null;
  successMessage: string | null;
}

export function LoginScreen({
  loginValue,
  passwordValue,
  onLoginChange,
  onPasswordChange,
  onSubmit,
  loginInputRef,
  isSubmitting,
  canSubmit,
  errorMessage,
  successMessage
}: LoginScreenProps) {
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

        <form onSubmit={onSubmit} aria-busy={isSubmitting}>
          <label htmlFor="login">Логин</label>
          <input
            autoComplete="username"
            autoCapitalize="none"
            id="login"
            name="login"
            ref={loginInputRef}
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
            value={passwordValue}
            onChange={(event) => onPasswordChange(event.currentTarget.value)}
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
