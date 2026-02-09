export interface Device {
  id: string;
  name: string;
  ip: string;
  publicIp?: string;
  version: string;
  connectedAt: string;
  claimedBy?: {
    userName: string;
    userAvatar: string;
  } | null;
}

export interface User {
  id: string;
  displayName: string;
  email: string;
  avatar: string;
}
