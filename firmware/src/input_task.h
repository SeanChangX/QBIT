// ==========================================================================
//  QBIT -- Input task (touch gesture state machine)
// ==========================================================================
#ifndef INPUT_TASK_H
#define INPUT_TASK_H

// FreeRTOS task: polls touch sensor and emits gesture events.
// Priority 3, stack 2048 bytes.
void inputTask(void *param);

#endif // INPUT_TASK_H
