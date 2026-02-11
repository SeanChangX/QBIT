// ---------------------------------------------------------------------------
//  Shared type definitions
// ---------------------------------------------------------------------------

import { WebSocket } from 'ws';

// ---- Auth ----
export interface AppUser {
  id: string;
  displayName: string;
  email: string;
  avatar: string;
}

// ---- Devices ----
export interface DeviceState {
  id: string;
  name: string;
  ip: string;
  publicIp: string;
  version: string;
  ws: WebSocket;
  connectedAt: Date;
}

// ---- Claims ----
export interface ClaimInfo {
  userId: string;
  userName: string;
  userAvatar: string;
  claimedAt: string;
}

export interface PendingClaim {
  userId: string;
  userName: string;
  userAvatar: string;
  timer: ReturnType<typeof setTimeout>;
}

// ---- Bans ----
export interface BannedList {
  userIds: string[];
  ips: string[];
  deviceIds: string[];
}

// ---- Users ----
export interface KnownUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  firstSeen: string;
  lastSeen: string;
  status: 'online' | 'offline';
}

// ---- Online users (Socket.io) ----
export interface OnlineUser {
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  ip: string;
  connectedAt: Date;
}

export interface OnlineUserPublic {
  userId: string;
  displayName: string;
  avatar?: string;
  connectedAt: string;
  socketIds: string[];
}

// ---- Library ----
export interface LibraryItem {
  id: string;
  filename: string;
  uploader: string;
  uploaderId: string;
  uploadedAt: string;
  size: number;
  frameCount: number;
}
