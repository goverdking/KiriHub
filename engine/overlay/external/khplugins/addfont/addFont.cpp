#include "ncbind.hpp"

#include <vector>
#include "FontSystem.h"
extern FontSystem *TVPFontSystem;
using namespace std;

#define NCB_MODULE_NAME TJS_W("addFont.dll")

struct FontEx {
    /**
     * プライベートフォントの追加
     * @param fontFileName フォントファイル名
     * @param extract アーカイブからテンポラリ展開する
     * @return void:ファイルを開くのに失敗 0:フォント登録に失敗
     * 数値:登録したフォントの数
     */
    static tjs_error addFont(tTJSVariant *result, tjs_int numparams,
                             tTJSVariant **param, iTJSDispatch2 *objthis) {
        if(numparams < 1)
            return TJS_E_BADPARAMCOUNT;

        ttstr filename = TVPGetPlacedPath(*param[0]);
        if(filename.length()) {
            std::vector<ttstr> faces;
            try {
                TVPFontSystem->AddExtraFont(filename.AsStdString(), &faces);
            } catch(const eTJS &error) {
                // The plugin reports an existing but unregistrable font as 0.
                TVPAddLog(TJS_W("[addFont] Registration failed: ") + filename);
                faces.clear();
            }
            int ret = static_cast<int>(faces.size());
            if(result) {
                *result = (int)ret;
            }
            return TJS_S_OK;
        }
        return TJS_S_OK;
    }
};

// フックつきアタッチ
NCB_ATTACH_CLASS(FontEx, System) {
    RawCallback("addFont", &FontEx::addFont, TJS_STATICMEMBER);
}
