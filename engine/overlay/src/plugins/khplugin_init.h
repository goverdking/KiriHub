/* SPDX-License-Identifier: MIT */

#pragma once

#include "tjsCommHead.h"

// Attempts to load a statically linked NCB plugin module (PSD / PSBFile).
// Returns true when the module was found and registered.
bool TVPTryLoadInternalPlugin(const ttstr &name);
