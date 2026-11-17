//---------------------------------------------------------------------------
/*
	FFmpeg based wave decoder for krkrsdl2.

	The built-in decoders only understand RIFF WAVE and Ogg Opus. Several
	KiriKiri games ship AAC audio inside an MP4 (M4A) container under a
	.ogg/.wav extension, which used to decode to silence. libavformat probes
	the actual container and libavcodec picks the real decoder, so this
	creator handles those files.

	Adapted from KrKiKiri2's FFWaveDecoder.cpp (MIT).
*/
//---------------------------------------------------------------------------
#include "tjsCommHead.h"

#include "WaveIntf.h"
#include "StorageIntf.h"
#include "BinaryStream.h"
#include "DebugIntf.h"
#include "MsgIntf.h"

extern "C" {
#ifndef __STDC_CONSTANT_MACROS
#define __STDC_CONSTANT_MACROS
#endif
#include "libavutil/avutil.h"
#include "libavutil/opt.h"
#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
};

//---------------------------------------------------------------------------
static bool FFmpegWaveInitialized = false;
static void TVPInitFFmpegForWave()
{
	if(!FFmpegWaveInitialized)
	{
		avcodec_register_all();
		av_register_all();
		FFmpegWaveInitialized = true;
	}
}
//---------------------------------------------------------------------------
static int AVReadFunc(void *opaque, uint8_t *buf, int buf_size)
{
	TJS::tTJSBinaryStream *stream = (TJS::tTJSBinaryStream *)opaque;
	return (int)stream->Read(buf, buf_size);
}
//---------------------------------------------------------------------------
static int64_t AVSeekFunc(void *opaque, int64_t offset, int whence)
{
	TJS::tTJSBinaryStream *stream = (TJS::tTJSBinaryStream *)opaque;
	switch(whence)
	{
		case AVSEEK_SIZE:
			return stream->GetSize();
		default:
			return stream->Seek(offset, whence & 0xFF);
	}
}
//---------------------------------------------------------------------------
class tTVPFFmpegWaveDecoder : public tTVPWaveDecoder
{
	bool IsPlanar;
	int StreamIdx;
	int audio_buf_index;
	int audio_buf_samples;
	int64_t audio_frame_next_pts;
	int64_t stream_start_time;
	tTVPWaveFormat Format;
	AVSampleFormat AVFmt;
	AVPacket pkt_temp;
	AVStream *AudioStream;

	// released in Clear()
	AVPacket Packet;
	tTJSBinaryStream *InputStream;
	AVFormatContext *FormatCtx;
	AVFrame *frame;

	void Clear()
	{
		if(Packet.data) av_packet_unref(&Packet);
		if(frame) { av_frame_free(&frame); frame = nullptr; }
		if(FormatCtx)
		{
			avformat_close_input(&FormatCtx);
			FormatCtx = nullptr;
		}
		if(InputStream) { InputStream->Destruct(); InputStream = nullptr; }
		if(AudioStream) AudioStream = nullptr;
	}

	bool ReadPacket()
	{
		for(;;)
		{
			int ret = av_read_frame(FormatCtx, &Packet);
			if(ret < 0) return false;
			if(Packet.stream_index == StreamIdx)
			{
				stream_start_time = AudioStream->start_time;
				return true;
			}
			av_packet_unref(&Packet);
		}
		return false;
	}

	int audio_decode_frame();

public:
	tTVPFFmpegWaveDecoder() : IsPlanar(false), StreamIdx(-1),
		audio_buf_index(0), audio_buf_samples(0), audio_frame_next_pts(0),
		stream_start_time(0), AVFmt(AV_SAMPLE_FMT_S16), AudioStream(nullptr),
		InputStream(nullptr), FormatCtx(nullptr), frame(nullptr)
	{
		memset(&Packet, 0, sizeof(Packet));
		memset(&pkt_temp, 0, sizeof(pkt_temp));
		memset(&Format, 0, sizeof(Format));
	}

	~tTVPFFmpegWaveDecoder() { Clear(); }

	// tTVPWaveDecoder
	void GetFormat(tTVPWaveFormat &format) { format = Format; }

	bool Render(void *buf, tjs_uint bufsamplelen, tjs_uint &rendered)
	{
		if(!InputStream) return false;
		int remain = (int)bufsamplelen;
		int sample_size =
			av_samples_get_buffer_size(nullptr, Format.Channels, 1, AVFmt, 1);
		unsigned char *stream = (unsigned char *)buf;
		while(remain > 0)
		{
			if(audio_buf_index >= audio_buf_samples)
			{
				int decoded = audio_decode_frame();
				if(decoded < 0) break;
				audio_buf_samples = decoded;
				audio_buf_index = 0;
			}
			int samples = audio_buf_samples - audio_buf_index;
			if(samples > remain) samples = remain;

			if(!IsPlanar || Format.Channels == 1)
			{
				memcpy(stream,
					frame->data[0] + audio_buf_index * sample_size,
					samples * sample_size);
				stream += samples * sample_size;
			}
			else
			{
				// Interleave planar samples. Each plane holds one channel and one
				// sample occupies Format.BytesPerSample bytes there -- NOT
				// sample_size (that is the size of one sample across all
				// channels and made every stereo file decode to noise).
				const int elem = (int)Format.BytesPerSample;
				int buf_pos = audio_buf_index * elem;
				int ch = (int)Format.Channels;
				for(int i = 0; i < samples; i++)
				{
					for(int j = 0; j < ch; j++)
					{
						memcpy(stream, frame->data[j] + buf_pos, elem);
						stream += elem;
					}
					buf_pos += elem;
				}
			}
			remain -= samples;
			audio_buf_index += samples;
		}
		rendered = bufsamplelen - remain;
return remain > 0 ? false : true;
	}

	bool SetPosition(tjs_uint64 samplepos)
	{
		if(!InputStream) return false;
		if(samplepos && !Format.Seekable) return false;

		int64_t seek_target = samplepos * AudioStream->time_base.den /
			((int64_t)Format.SamplesPerSec * AudioStream->time_base.num);
		if(AudioStream->start_time != AV_NOPTS_VALUE)
			seek_target += AudioStream->start_time;

		if(Packet.duration <= 0)
		{
			if(Packet.data) av_packet_unref(&Packet);
			if(!ReadPacket())
			{
				int ret = avformat_seek_file(FormatCtx, StreamIdx, 0, 0, 0,
					AVSEEK_FLAG_BACKWARD);
				if(ret < 0) return false;
				if(!ReadPacket()) return false;
			}
		}
		int64_t seek_temp = seek_target - Packet.duration;
		for(;;)
		{
			if(seek_temp < 0) seek_temp = 0;
			int ret = avformat_seek_file(FormatCtx, StreamIdx, seek_temp,
				seek_temp, seek_temp, AVSEEK_FLAG_BACKWARD);
			if(ret < 0) return false;
			if(Packet.data) av_packet_unref(&Packet);
			if(!ReadPacket()) return false;
			if(seek_target < Packet.dts)
			{
				seek_temp -= Packet.duration;
				continue;
			}
			pkt_temp = Packet;
			do
			{
				audio_buf_samples = audio_decode_frame();
				if(audio_buf_samples < 0) return false;
			} while(samplepos > (tjs_uint64)audio_frame_next_pts);
			audio_buf_index = (int)((int64_t)samplepos - frame->pts);
			if(audio_buf_index < 0) audio_buf_index = 0;
			return true;
		}
		return false;
	}

	bool SetStream(const ttstr &url);
};
//---------------------------------------------------------------------------
int tTVPFFmpegWaveDecoder::audio_decode_frame()
{
	AVStream *audio_st = AudioStream;
	AVCodecContext *dec = audio_st->codec;
	for(;;)
	{
		while(pkt_temp.stream_index != -1)
		{
			if(!frame) frame = av_frame_alloc();
			else av_frame_unref(frame);

			int got_frame = 0;
			int len1 = avcodec_decode_audio4(dec, frame, &got_frame, &pkt_temp);
			if(len1 < 0)
			{
				pkt_temp.size = 0;
				break;
			}
			pkt_temp.dts = pkt_temp.pts = AV_NOPTS_VALUE;
			pkt_temp.data += len1;
			pkt_temp.size -= len1;
			if((pkt_temp.data && pkt_temp.size <= 0) ||
				(!pkt_temp.data && !got_frame))
				pkt_temp.stream_index = -1;
			if(!got_frame) continue;

			AVRational tb = { 1, frame->sample_rate };
			if(frame->pts != AV_NOPTS_VALUE)
				frame->pts = av_rescale_q(frame->pts, dec->time_base, tb);
			else if(frame->pkt_pts != AV_NOPTS_VALUE)
				frame->pts = av_rescale_q(frame->pkt_pts,
					audio_st->time_base, tb);
			else if(audio_frame_next_pts != AV_NOPTS_VALUE)
			{
				AVRational a = { 1, (int)Format.SamplesPerSec };
				frame->pts = av_rescale_q(audio_frame_next_pts, a, tb);
			}
			if(frame->pts != AV_NOPTS_VALUE)
				audio_frame_next_pts = frame->pts + frame->nb_samples;
			return frame->nb_samples;
		}

		if(Packet.data) av_packet_unref(&Packet);
		pkt_temp.stream_index = -1;
		if(!ReadPacket()) return -1;
		pkt_temp = Packet;
	}
	return -1;
}
//---------------------------------------------------------------------------
bool tTVPFFmpegWaveDecoder::SetStream(const ttstr &url)
{
	Clear();

	TVPAddLog(TJS_W("[ffwave] open ") + url);
	InputStream = TVPCreateBinaryStreamForRead(url, TJS_W(""));
	if(!InputStream) return false;

	int bufSize = 32 * 1024;
	AVIOContext *pIOCtx = avio_alloc_context(
		(unsigned char *)av_malloc(bufSize + AVPROBE_PADDING_SIZE),
		bufSize, 0, InputStream, AVReadFunc, 0, AVSeekFunc);

	AVInputFormat *fmt = nullptr;
	tTJSNarrowStringHolder holder(url.c_str());
	// Keep probing tight: every byte read is a synchronous HTTP range request
	// on the web build, and the default 5 MB probe makes startup crawl.
	av_probe_input_buffer2(pIOCtx, &fmt, holder, nullptr, 0, 32768);
	AVDictionary *opts = nullptr;
	av_dict_set(&opts, "probesize", "32768", 0);
	av_dict_set(&opts, "analyzeduration", "100000", 0);
	AVFormatContext *ic = avformat_alloc_context();
	if(!ic)
	{
		av_free(pIOCtx->buffer);
		av_free(pIOCtx);
		av_dict_free(&opts);
		return false;
	}
	ic->pb = pIOCtx;
	if(avformat_open_input(&ic, "", fmt, &opts) < 0)
	{
		// avformat_open_input frees ic (and its pb) on failure
		av_dict_free(&opts);
		return false;
	}
	av_dict_free(&opts);
	FormatCtx = ic;
	TVPAddLog(TJS_W("[ffwave] open_input ok"));

	if(avformat_find_stream_info(ic, nullptr) < 0) return false;
	if(ic->pb) ic->pb->eof_reached = 0;

	StreamIdx = av_find_best_stream(ic, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
	if(StreamIdx < 0) return false;

	AVCodecContext *avctx = ic->streams[StreamIdx]->codec;
	if(avctx->codec_type != AVMEDIA_TYPE_AUDIO) return false;

	AVCodec *codec = avcodec_find_decoder(avctx->codec_id);
	if(!codec) return false;

	avctx->codec_id = codec->id;
	avctx->workaround_bugs = 1;
	avctx->error_concealment = 3;
	if(codec->capabilities & CODEC_CAP_DR1)
		avctx->flags |= CODEC_FLAG_EMU_EDGE;

	if(avcodec_open2(avctx, codec, nullptr) < 0) return false;

	Format.SamplesPerSec = avctx->sample_rate;
	Format.Channels = avctx->channels;
	Format.Seekable = (ic->iformat->flags &
		(AVFMT_NOBINSEARCH | AVFMT_NOGENSEARCH | AVFMT_NO_BYTE_SEEK)) !=
		(AVFMT_NOBINSEARCH | AVFMT_NOGENSEARCH | AVFMT_NO_BYTE_SEEK);
	Format.IsFloat = false;
	switch(AVFmt = avctx->sample_fmt)
	{
		case AV_SAMPLE_FMT_S16P:
		case AV_SAMPLE_FMT_S16:
			Format.BitsPerSample = 16;
			break;
		case AV_SAMPLE_FMT_FLTP:
		case AV_SAMPLE_FMT_FLT:
			Format.BitsPerSample = 32;
			Format.IsFloat = true;
			break;
		case AV_SAMPLE_FMT_S32P:
		case AV_SAMPLE_FMT_S32:
			Format.BitsPerSample = 32;
			break;
		default:
			return false;
	}
	IsPlanar = (AVFmt == AV_SAMPLE_FMT_S16P || AVFmt == AV_SAMPLE_FMT_FLTP ||
		AVFmt == AV_SAMPLE_FMT_S32P);
	Format.BytesPerSample = Format.BitsPerSample / 8;
	Format.SpeakerConfig = 0;
	AudioStream = ic->streams[StreamIdx];
	Format.TotalTime =
		(tjs_uint64)(av_q2d(AudioStream->time_base) *
			AudioStream->duration * 1000);
	Format.TotalSamples =
		(tjs_uint64)(av_q2d(AudioStream->time_base) *
			AudioStream->duration * Format.SamplesPerSec);

	audio_buf_index = 0;
	audio_buf_samples = 0;
	audio_frame_next_pts = 0;
	pkt_temp.stream_index = -1;
	TVPAddLog(TJS_W("[ffwave] ready ") + ttstr((tjs_int)Format.SamplesPerSec) +
		TJS_W("Hz ch=") + ttstr((tjs_int)Format.Channels) +
		TJS_W(" total=") + ttstr((tjs_int)Format.TotalSamples));
	return true;
}
//---------------------------------------------------------------------------
class tTVPFFmpegWaveDecoderCreator : public tTVPWaveDecoderCreator
{
public:
	tTVPWaveDecoder * Create(const ttstr & storagename, const ttstr &extension)
	{
		if(extension == TJS_W(".wav") || extension == TJS_W(".wv") ||
			extension == TJS_W(".spx"))
			return NULL; // let the built-in decoders handle these

		TVPInitFFmpegForWave();
		tTVPFFmpegWaveDecoder *decoder = new tTVPFFmpegWaveDecoder();
		if(!decoder->SetStream(storagename))
		{
			delete decoder;
			return NULL;
		}
		return decoder;
	}
} static FFmpegWaveDecoderCreator;
//---------------------------------------------------------------------------
void TVPRegisterFFmpegWaveDecoderCreator()
{
	static bool registered = false;
	if(!registered)
	{
		TVPRegisterWaveDecoderCreator(&FFmpegWaveDecoderCreator);
		registered = true;
	}
}
//---------------------------------------------------------------------------
