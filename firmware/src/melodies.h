// ==========================================================================
//  QBIT -- RTTTL melody constants
// ==========================================================================
#ifndef MELODIES_H
#define MELODIES_H

// Boot animation melody
static const char BOOT_MELODY[] =
    "tronboot:d=16,o=5,b=160:"
    "c,16p,g,16p,c6,16p,b,8a";

// Touch (coin) sound — played on GIF switch
static const char TOUCH_MELODY[] =
    "coin:d=16,o=5,b=600:b5,e6";

// Poke notification — ascending chime
static const char POKE_MELODY[] =
    "poke:d=16,o=5,b=200:c6,e6,g6,c7";

// Claim confirmation — short arpeggio
static const char CLAIM_MELODY[] =
    "claim:d=8,o=5,b=180:e,g,b";

// Mute feedback — single descending tone
static const char MUTE_MELODY[] =
    "mute:d=16,o=5,b=200:g5,c5";

// Unmute feedback — single ascending tone
static const char UNMUTE_MELODY[] =
    "unmute:d=16,o=5,b=200:c5,g5";

#endif // MELODIES_H
