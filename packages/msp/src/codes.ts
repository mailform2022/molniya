/** MSP v1 command IDs (subset used by VTX Services). */
export const MSP = {
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  VTX_CONFIG: 88,
  SET_VTX_CONFIG: 89,
  EEPROM_WRITE: 250,
  REBOOT: 68,
  SET_CLI: 0xf3, // not in upstream INAV; kept as an alias for CLI entry via serial '#'
  CLI_EXIT: 0xf4,
  UID: 160,
  RC: 105
} as const;

/** MSP v2 INAV commands (0x2000+). */
export const MSP2 = {
  INAV_STATUS: 0x2000,
  INAV_MISC: 0x2002,
  INAV_SET_MISC: 0x2003,
  INAV_OSD_LAYOUTS: 0x2012,
  INAV_OSD_SET_LAYOUT_ITEM: 0x2013,
  INAV_MIXER: 0x2010,
  INAV_SET_MIXER: 0x2011,
  INAV_OUTPUT_MAPPING_EXT: 0x201d,
  /** Custom 3.3 GHz grid table (already in mailform2022/inav). */
  INAV_VTX_TABLE_CUSTOM: 0x2f00,
  INAV_SET_VTX_TABLE_CUSTOM: 0x2f01
} as const;

/** VTX Services custom MSP2 commands implemented in the forked INAV / transmitter firmware. */
export const MSP2_VTX = {
  VTX_MAP_READ: 0x2f10,
  VTX_MAP_WRITE: 0x2f11,
  VTX_MAP_SET: 0x2f12,
  VTX_MAP_LIVE: 0x2f13,
  GET_UID: 0x2f20,
  SET_AUTH_TOKEN: 0x2f21,
  GET_AUTH_STATUS: 0x2f22
} as const;

export const VTX_MAP_MAX_PAIRS = 16;

export interface VtxPair {
  band: number; // 1..5
  channel: number; // 1..8
  freqMhz: number;
  rcChannel: number; // 5..16
  rcLevel: number; // 900..2100
}

export interface AuthStatus {
  authorized: boolean;
  plan: string;
  expiresAt: number; // unix seconds, 0 = none
  deviceLimit: number;
  devicesUsed: number;
}
