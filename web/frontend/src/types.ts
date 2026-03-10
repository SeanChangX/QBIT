export interface Device {
  id: string;
  name: string;
  ip: string;
  publicIp?: string;
  version: string;
  connectedAt: string;
  pokeToken: string;
  claimedBy?: {
    publicUserId: string;
    userName: string;
    userAvatar: string;
  } | null;
}

export interface UserSettings {
  onlyFriendsCanPoke: boolean;
}

export interface User {
  publicUserId: string;
  displayName: string;
  email: string;
  avatar: string;
}

export interface OnlineUser {
  publicUserId: string;
  displayName: string;
  avatar?: string;
  connectedAt: string;
  socketIds: string[];
}
