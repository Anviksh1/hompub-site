import type { Room } from './room';
import type { Directory } from './directory';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ASSETS: Fetcher;
  ALLOWED_ORIGINS: string;
  MAX_PLAYERS: string;
  ROOM_CREATE_PER_IP_PER_DAY: string;
  ROOM_CREATE_PER_DAY: string;
}
