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
  fileServerBaseURL: 'http://photos2.dynaspirit.com:8080',
  fileServerUsername: 'vr',
  fileServerPassword: 'lavrcestbien',
  tr4kerApiKey: '',
} as const;

export const TR4KER_URL = 'https://tr4ker.net/';
export const ALLOCINE_URL = 'https://www.allocine.fr';
