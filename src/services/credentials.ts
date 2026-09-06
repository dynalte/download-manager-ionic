/**
 * Port de CredentialsStore.swift — Keychain -> Capacitor Preferences (chiffré par l'OS).
 */
import { Preferences } from '@capacitor/preferences';

const SERVICE_KEY = 'tr4ker_login_v1';

export interface StoredCredentials {
  username: string;
  password: string;
}

export async function saveCredentials(username: string, password: string): Promise<void> {
  await Preferences.set({ key: SERVICE_KEY, value: JSON.stringify({ username, password }) });
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const { value } = await Preferences.get({ key: SERVICE_KEY });
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredCredentials;
    if (!parsed.username || !parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}
