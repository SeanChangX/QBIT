// ==========================================================================
//  QBIT -- Health reminder system (water / food / pills)
// ==========================================================================
#ifndef REMINDER_H
#define REMINDER_H

#include <Arduino.h>

// -------------------------------------------------------------------------
//  Reminder types
// -------------------------------------------------------------------------
enum ReminderType : uint8_t {
    REM_WATER = 0,
    REM_FOOD  = 1,
    REM_PILLS = 2,
    REM_COUNT = 3
};

// -------------------------------------------------------------------------
//  Water / Pills config (interval-based)
// -------------------------------------------------------------------------
struct ReminderIntervalCfg {
    bool    enabled;
    uint16_t intervalMin;   // minutes between reminders
    uint8_t  startHour;     // first reminder hour (0-23)
    uint8_t  endHour;       // last reminder hour  (0-23, exclusive wrap)
};

// -------------------------------------------------------------------------
//  Food config (fixed-time meals)
// -------------------------------------------------------------------------
struct ReminderFoodCfg {
    bool    enabled;
    uint8_t breakfastH, breakfastM;   // 24h format
    uint8_t lunchH,     lunchM;
    uint8_t dinnerH,    dinnerM;
};

// -------------------------------------------------------------------------
//  Init / NVS
// -------------------------------------------------------------------------

// Load reminder settings from NVS (call after settingsInit).
void reminderLoadSettings();

// Persist current reminder settings to NVS.
void reminderSaveSettings();

// -------------------------------------------------------------------------
//  Enable / disable (on-board toggle)
// -------------------------------------------------------------------------
bool reminderGetEnabled(ReminderType type);
void reminderSetEnabled(ReminderType type, bool enabled);

// -------------------------------------------------------------------------
//  Full config (web UI)
// -------------------------------------------------------------------------
ReminderIntervalCfg reminderGetWaterCfg();
void                reminderSetWaterCfg(const ReminderIntervalCfg &cfg);

ReminderFoodCfg     reminderGetFoodCfg();
void                reminderSetFoodCfg(const ReminderFoodCfg &cfg);

ReminderIntervalCfg reminderGetPillsCfg();
void                reminderSetPillsCfg(const ReminderIntervalCfg &cfg);

// -------------------------------------------------------------------------
//  Tick + display (called from display_task GIF_PLAYBACK tick)
// -------------------------------------------------------------------------

// Check if a reminder should fire now. Returns REM_COUNT if none pending.
// Caller should enter REMINDER_DISPLAY state when return != REM_COUNT.
ReminderType reminderCheck();

// Draw the reminder overlay (48x48 icon + label).
// type: which reminder is active
// Call when state is REMINDER_DISPLAY.
void reminderDraw(ReminderType type);

// Get the display label for the active reminder ("Drink Water", meal name, etc.)
const char *reminderGetLabel(ReminderType type);

#endif // REMINDER_H
