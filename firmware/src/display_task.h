// ==========================================================================
//  QBIT -- Display task (state machine)
// ==========================================================================
#ifndef DISPLAY_TASK_H
#define DISPLAY_TASK_H

// FreeRTOS task: runs the display state machine.
// Priority 2, stack 8192 bytes.
void displayTask(void *param);

#endif // DISPLAY_TASK_H
