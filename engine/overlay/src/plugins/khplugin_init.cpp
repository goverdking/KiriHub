/* SPDX-License-Identifier: MIT */

// Static NCB plugin registration for the Kiri Hub Web build.
//
// psdfile and psbfile are compiled into krkrsdl2common. Their NCB registrars
// only run when the module is loaded through ncbAutoRegister, so Plugins.link
// is redirected here for these modules instead of trying to dlopen a DLL.

#include "khplugin_init.h"

#include "ncbind.hpp"
#include "PSBMediaRegistry.h"
#include "DebugIntf.h"
#include <map>
#include <set>

// psdfile/main.cpp
extern void initStorage();

// Taking the addresses forces the linker to keep the plugin object files (and
// therefore their static NCB registrars) in the final image.
static void *volatile kh_force_psb_init = reinterpret_cast<void *>(&initPsbFile);
static void *volatile kh_force_psd_init = reinterpret_cast<void *>(&initStorage);

// Web-only diagnostics. Plugins.link keeps its historical void return value.
static std::map<ttstr, ttstr> KhPluginErrors;
static std::set<ttstr> KhReportedMissingPlugins;

#define NCB_MODULE_NAME TJS_W("webengine.dll")
struct KhWebPluginDiagnostics {
	static ttstr getWebModuleStatus(ttstr name) {
		name.ToLowerCase();
		if(KhPluginErrors.count(name)) return TJS_W("failed");
		if(TVPRegisteredPlugins.count(name)) return TJS_W("loaded");
		return ncbAutoRegister::HasModule(name) ? TJS_W("available") : TJS_W("missing");
	}
};
NCB_ATTACH_CLASS(KhWebPluginDiagnostics, Plugins) {
	NCB_METHOD(getWebModuleStatus);
}

static bool KhLoadInternalModule(const ttstr &module)
{
	try
	{
		const ttstr name = module.AsLowerCase();
		if(TVPRegisteredPlugins.count(name)) return true;
		if(!ncbAutoRegister::HasModule(name)) {
			if(KhReportedMissingPlugins.insert(name).second)
				TVPAddLog(TJS_W("[web-plugin] Missing static module: ") + module);
			return false;
		}
		const bool loaded = ncbAutoRegister::LoadModule(name);
		if(loaded) KhPluginErrors.erase(name);
		return loaded;
	}
	catch(const eTJS &error)
	{
		KhPluginErrors[module.AsLowerCase()] = error.GetMessage();
		TVPAddLog(TJS_W("[web-plugin] Registration failed: ") + module + TJS_W(": ") + error.GetMessage());
		return false;
	}
	catch(...)
	{
		KhPluginErrors[module.AsLowerCase()] = TJS_W("Unknown registration error");
		TVPAddLog(TJS_W("[web-plugin] Registration failed: ") + module);
		return false;
	}
}

bool TVPTryLoadInternalPlugin(const ttstr &name)
{
	static bool registered = false;
	if(!registered)
	{
		ncbAutoRegister::AllRegist();
		registered = true;
		KhLoadInternalModule(TJS_W("webengine.dll"));
		// The original engine ships psd.dll and psbfile.dll as built-in
		// plugins, so the game never links them explicitly. Register both as
		// soon as the script engine asks about any plugin.
		KhLoadInternalModule(TJS_W("psd.dll"));
		KhLoadInternalModule(TJS_W("psbfile.dll"));
	}
	return KhLoadInternalModule(name);
}
