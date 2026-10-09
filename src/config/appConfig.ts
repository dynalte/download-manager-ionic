/**
 * Port de AppConfig.swift — valeurs par défaut (surchargées par les Réglages).
 */
export const AppConfig = {
  transmissionRPCURL: 'http://photos2.dynaspirit.com:9091/transmission/rpc',
  transmissionUsername: 'CHANGE_ME',
  transmissionPassword: 'CHANGE_ME',
  plexBaseURL: 'http://photos2.dynaspirit.com:32400',
  plexToken: '',
  plexUseCloudDefault: false,
  // Même origine https que la PWA (même conteneur Apache que le :8080) :
  // évite mixed-content + CORS sur le fetch des e-books.
  fileServerBaseURL: 'https://photos2.dynaspirit.com',
  fileServerUsername: 'vr',
  fileServerPassword: 'lavrcestbien',
  tr4kerApiKey: '',
  c411ApiKey: '',
  v3xApiKey: '',
} as const;

export const TR4KER_URL = 'https://tr4ker.net/';
export const ALLOCINE_URL = 'https://www.allocine.fr';
