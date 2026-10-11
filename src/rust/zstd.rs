use std::alloc;

extern "C" {
    fn ZSTD_createDStream() -> u32;
    fn ZSTD_freeDStream(ctx: u32) -> i32;
    fn ZSTD_decompressStream_simpleArgs(
        ctx: u32,
        dst: *mut u8,
        dstCapacity: u32,
        dstPos: *mut u32,
        src: *const u8,
        srcSize: u32,
        srcPos: *mut u32,
    ) -> i32;

    fn ZSTD_isError(err: i32) -> bool;
}

const MALLOC_ALIGN: usize = 16;

// malloc and free are needed by the zstd library
#[no_mangle]
pub unsafe fn v86_malloc(size: u32) -> u32 {
    let layout = alloc::Layout::from_size_align(size as usize + 4, MALLOC_ALIGN).unwrap();
    let addr = alloc::alloc(layout);
    *(addr as *mut u32) = size as u32;
    addr as u32 + 4
}
#[no_mangle]
pub unsafe fn v86_free(addr: u32) {
    let size = *((addr - 4) as *mut u32);
    let layout = alloc::Layout::from_size_align(size as usize + 4, MALLOC_ALIGN).unwrap();
    alloc::dealloc((addr - 4) as *mut u8, layout)
}

pub struct ZstdContext {
    ctx: u32,
    src: *mut u8,
    src_size: u32,
    src_pos: u32,
}

#[no_mangle]
pub unsafe fn zstd_create_ctx(src_size: u32) -> *mut ZstdContext {
    let src = alloc::alloc(alloc::Layout::from_size_align(src_size as usize, 1).unwrap());
    let ctx = ZSTD_createDStream();
    let result = alloc::alloc(alloc::Layout::new::<ZstdContext>()) as *mut ZstdContext;
    *result = ZstdContext {
        ctx,
        src,
        src_size,
        src_pos: 0,
    };
    result
}

#[no_mangle]
pub unsafe fn zstd_get_src_ptr(ctx: *mut ZstdContext) -> *mut u8 { (*ctx).src }

#[no_mangle]
pub unsafe fn zstd_free_ctx(ctx: *mut ZstdContext) {
    alloc::dealloc(
        (*ctx).src,
        alloc::Layout::from_size_align((*ctx).src_size as usize, 1).unwrap(),
    );
    ZSTD_freeDStream((*ctx).ctx);
    std::ptr::drop_in_place(ctx);
}

#[no_mangle]
pub unsafe fn zstd_read(ctx: *mut ZstdContext, length: u32) -> *mut u8 {
    let dst = alloc::alloc(alloc::Layout::from_size_align(length as usize, 1).unwrap());
    let mut dst_pos = 0;
    let result = ZSTD_decompressStream_simpleArgs(
        (*ctx).ctx,
        dst,
        length,
        &mut dst_pos,
        (*ctx).src,
        (*ctx).src_size,
        &mut (*ctx).src_pos,
    );
    if ZSTD_isError(result) {
        dbg_log!(
            "ZSTD_decompressStream_simpleArgs returned error: {}",
            result
        );
        dbg_assert!(false);
        zstd_read_free(dst, length);
        return std::ptr::null_mut::<u8>();
    }
    if dst_pos != length {
        dbg_assert!(false, "ZSTD: Partial read");
        zstd_read_free(dst, length);
        return std::ptr::null_mut::<u8>();
    }
    dst
}
#[no_mangle]
pub unsafe fn zstd_read_free(ptr: *mut u8, length: u32) {
    alloc::dealloc(
        ptr,
        alloc::Layout::from_size_align(length as usize, 1).unwrap(),
    );
}

/// A decompression stream with fixed input and output buffers, for sources that arrive in
/// chunks and are consumed as they are decompressed (zstd_create_ctx needs the whole
/// compressed input in memory)
pub struct ZstdStream {
    ctx: u32,
    src: *mut u8,
    src_size: u32,
    src_pos: u32,
    dst: *mut u8,
}

const ZSTD_STREAM_BUFFER_SIZE: u32 = 1 << 20;

#[no_mangle]
pub unsafe fn zstd_stream_create() -> *mut ZstdStream {
    let layout = alloc::Layout::from_size_align(ZSTD_STREAM_BUFFER_SIZE as usize, 1).unwrap();
    let result = alloc::alloc(alloc::Layout::new::<ZstdStream>()) as *mut ZstdStream;
    *result = ZstdStream {
        ctx: ZSTD_createDStream(),
        src: alloc::alloc(layout),
        src_size: 0,
        src_pos: 0,
        dst: alloc::alloc(layout),
    };
    result
}

#[no_mangle]
pub unsafe fn zstd_stream_free(stream: *mut ZstdStream) {
    let layout = alloc::Layout::from_size_align(ZSTD_STREAM_BUFFER_SIZE as usize, 1).unwrap();
    alloc::dealloc((*stream).src, layout);
    alloc::dealloc((*stream).dst, layout);
    ZSTD_freeDStream((*stream).ctx);
    alloc::dealloc(stream as *mut u8, alloc::Layout::new::<ZstdStream>());
}

#[no_mangle]
pub unsafe fn zstd_stream_buffer_size() -> u32 { ZSTD_STREAM_BUFFER_SIZE }
#[no_mangle]
pub unsafe fn zstd_stream_src_ptr(stream: *mut ZstdStream) -> *mut u8 { (*stream).src }
#[no_mangle]
pub unsafe fn zstd_stream_dst_ptr(stream: *mut ZstdStream) -> *mut u8 { (*stream).dst }

/// The next `size` bytes of compressed input have been written to the input buffer
#[no_mangle]
pub unsafe fn zstd_stream_set_input(stream: *mut ZstdStream, size: u32) {
    dbg_assert!(size <= ZSTD_STREAM_BUFFER_SIZE);
    (*stream).src_size = size;
    (*stream).src_pos = 0;
}

/// Compressed bytes of the input buffer that haven't been consumed yet
#[no_mangle]
pub unsafe fn zstd_stream_input_left(stream: *mut ZstdStream) -> u32 {
    (*stream).src_size - (*stream).src_pos
}

/// Decompress from the input buffer into the output buffer. Returns the number of bytes
/// written to the output buffer (0: more input is needed), or -1 on error. Output may be
/// pending even when no input is left, so call this until it returns 0.
#[no_mangle]
pub unsafe fn zstd_stream_decompress(stream: *mut ZstdStream) -> i32 {
    let mut dst_pos = 0;
    let result = ZSTD_decompressStream_simpleArgs(
        (*stream).ctx,
        (*stream).dst,
        ZSTD_STREAM_BUFFER_SIZE,
        &mut dst_pos,
        (*stream).src,
        (*stream).src_size,
        &mut (*stream).src_pos,
    );
    if ZSTD_isError(result) {
        dbg_log!(
            "ZSTD_decompressStream_simpleArgs returned error: {}",
            result
        );
        return -1;
    }
    dst_pos as i32
}
