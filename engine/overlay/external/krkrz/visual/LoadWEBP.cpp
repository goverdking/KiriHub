#include <webp/decode.h>
#include "tjsCommHead.h"
#include "GraphicsLoaderIntf.h"
#include "MsgIntf.h"
#include "tjsDictionary.h"
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

void TVPLoadWEBP(void *formatdata, void *callbackdata,
                 tTVPGraphicSizeCallback sizecallback,
                 tTVPGraphicScanLineCallback scanlinecallback,
                 tTVPMetaInfoPushCallback metainfopushcallback,
                 tTJSBinaryStream *src, tjs_int keyidx,
                 tTVPGraphicLoadMode mode) {
    WebPDecoderConfig config;
    if(WebPInitDecoderConfig(&config) == 0) {
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    }

    int datasize = src->GetSize();
    std::unique_ptr<uint8_t[]> data(new uint8_t[datasize]);
    src->ReadBuffer(data.get(), datasize);
    if(WebPGetFeatures(data.get(), datasize, &config.input) != VP8_STATUS_OK) {
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    }

    const tjs_uint width = config.input.width;
    const tjs_uint height = config.input.height;
    sizecallback(callbackdata, width, height);

    if(mode == glmNormal || mode == glmNormalRGBA) {
        const tjs_uint stride = width * 4;
        std::vector<uint8_t> image(static_cast<size_t>(stride) * height);
        config.output.colorspace = (mode == glmNormalRGBA) ? MODE_RGBA : MODE_BGRA;
        config.output.u.RGBA.rgba = image.data();
        config.output.u.RGBA.stride = stride;
        config.output.u.RGBA.size = static_cast<size_t>(stride) * height;
        config.output.is_external_memory = 1;
        if(WebPDecode(data.get(), datasize, &config) != VP8_STATUS_OK) {
            TVPThrowExceptionMessage(TJS_W("Invalid WebP image(RGBA mode)"));
        }
        for(tjs_uint y = 0; y < height; y++) {
            void *scanline = scanlinecallback(callbackdata, (tjs_int)y);
            if(scanline) {
                std::memcpy(scanline, image.data() + static_cast<size_t>(y) * stride, stride);
            }
        }
        scanlinecallback(callbackdata, -1);
    } else if(mode == glmGrayscale) {
        const tjs_uint stride = width;
        std::vector<uint8_t> yplane(static_cast<size_t>(stride) * height);
        const tjs_uint uvSize = width * height / 4 + width + width;
        std::vector<uint8_t> dummy(uvSize);
        config.output.colorspace = MODE_YUV;
        config.output.u.YUVA.y = yplane.data();
        config.output.u.YUVA.u = dummy.data();
        config.output.u.YUVA.v = dummy.data();
        config.output.u.YUVA.a = nullptr;
        config.output.u.YUVA.y_stride = stride;
        config.output.u.YUVA.u_stride = width / 2;
        config.output.u.YUVA.v_stride = width / 2;
        config.output.u.YUVA.a_stride = 0;
        config.output.u.YUVA.y_size = static_cast<size_t>(stride) * height;
        config.output.u.YUVA.u_size = uvSize;
        config.output.u.YUVA.v_size = uvSize;
        config.output.u.YUVA.a_size = 0;
        config.output.is_external_memory = 1;
        if(WebPDecode(data.get(), datasize, &config) != VP8_STATUS_OK) {
            TVPThrowExceptionMessage(TJS_W("Invalid WebP image(Grayscale Mode)"));
        }
        for(tjs_uint y = 0; y < height; y++) {
            void *scanline = scanlinecallback(callbackdata, (tjs_int)y);
            if(scanline) {
                std::memcpy(scanline, yplane.data() + static_cast<size_t>(y) * stride, width);
            }
        }
        scanlinecallback(callbackdata, -1);
    } else {
        TVPThrowExceptionMessage(TJS_W("WebP does not support palettized image"));
    }
}

void TVPLoadHeaderWEBP(void *formatdata, tTJSBinaryStream *src,
                       iTJSDispatch2 **dic) {
    WebPDecoderConfig config;
    if(WebPInitDecoderConfig(&config) == 0) {
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    }

    int datasize = src->GetSize();
    std::unique_ptr<uint8_t[]> data(new uint8_t[datasize]);
    src->ReadBuffer(data.get(), datasize);
    if(WebPGetFeatures(data.get(), datasize, &config.input) != VP8_STATUS_OK) {
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    }

    *dic = TJSCreateDictionaryObject();
    tTJSVariant val((tjs_int32)config.input.width);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("width"), nullptr, &val, (*dic));
    val = tTJSVariant((tjs_int32)config.input.height);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("height"), nullptr, &val, (*dic));
    val = tTJSVariant(config.input.has_alpha ? 32 : 24);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("bpp"), nullptr, &val, (*dic));
}
