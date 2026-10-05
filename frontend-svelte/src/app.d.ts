declare global {
  namespace App {
    interface Error {
      message: string;
    }
    interface PageState {
      challengeId?: string;
    }
  }
}

export {};
