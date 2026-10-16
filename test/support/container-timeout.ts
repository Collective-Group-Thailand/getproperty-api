// Container start-up (first image pull included) is slow; `testTimeout` is global-only in Jest.
jest.setTimeout(180_000);
