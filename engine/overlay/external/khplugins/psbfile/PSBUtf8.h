#pragma once

#include <string>

#include "CharacterSet.h"
#include "tjsString.h"

namespace PSB {
    // PSB stores dictionary keys as UTF-8. TJS strings are wide, and the
    // default tTJSNarrowStringHolder path fails on non-ASCII names.
    inline ttstr Utf8ToTjs(const std::string &in) {
        tjs_string wide;
        if(!TVPUtf8ToUtf16(wide, in)) {
            return ttstr();
        }
        return ttstr(wide);
    }

    inline std::string TjsToUtf8(const ttstr &in) {
        std::string narrow;
        if(!TVPUtf16ToUtf8(narrow, in.AsStdString())) {
            return std::string();
        }
        return narrow;
    }
} // namespace PSB
