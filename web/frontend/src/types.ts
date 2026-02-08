export interface Device {
  id: string;
  name: string;
  ip: string;
  version: string;
  connectedAt: string;
}

export interface User {
  id: string;
  displayName: string;
  email: string;
  avatar: string;
}
