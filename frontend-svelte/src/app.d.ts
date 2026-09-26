// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Error {
      message: string;
    }
    /** History state of an entry (`goto(url, { state })`): the 2FA challenge of a login (`/login/2fa`). */
    interface PageState {
      challengeId?: string;
    }
  }
}

export {};
