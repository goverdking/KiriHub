#include <iostream>
#include "psdparse.h"
#include "psdfile.h"
#include "ncbind.hpp"

#define NCB_MODULE_NAME TJS_W("psbfile.dll")

using namespace psd;

// psdファイルをロードする
// The Web port loads PSD data through TVP storage (PSD::loadStream), so the
// local-file helper is intentionally disabled. This also removes the plugin's
// dependency on Boost.Iostreams, whose exception model does not match the
// krkrsdl2 Emscripten build.
bool PSDFile::load(const char *filename) {
    (void)filename;
    clearData();
    isLoaded = false;
    std::cerr << "PSDFile::load(const char*) is not available in the Web port"
              << std::endl;
    return false;
}