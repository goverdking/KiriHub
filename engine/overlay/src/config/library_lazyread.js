// Suspend at the syscall boundary. Suspending inside FS.read would replay
// doReadv's JS-side position changes when Asyncify rewinds a multi-iovec read.
addToLibrary({
  $krkrReadv__deps: ['$FS', '$SYSCALLS', '$doReadv', '$Asyncify'],
  $krkrReadv: function(fd, iov, iovcnt, offset, pnum) {
    var stream = SYSCALLS.getStreamFromFD(fd);
    if (stream.node.krkrRemote && (Asyncify.state === 2 ||
        !Module['lazyReadvCached'](stream, iov, iovcnt, offset, HEAPU8))) {
      return Asyncify.handleSleep(function(wakeUp) {
        Module['lazyReadv'](stream, iov, iovcnt, offset, pnum, function() { return HEAPU8; }).then(
          function() { wakeUp(0); },
          function(error) {
            console.error('Resource read failed:', error);
            wakeUp(29); // WASI EIO, returned through libc's normal error path.
          });
      });
    }
    var count = doReadv(stream, iov, iovcnt, offset);
    HEAPU32[pnum >> 2] = count;
    return 0;
  },
  fd_read__deps: ['$krkrReadv'],
  fd_read: function(fd, iov, iovcnt, pnum) {
    return krkrReadv(fd, iov, iovcnt, undefined, pnum);
  },
  fd_pread__deps: ['$krkrReadv'],
  fd_pread__i53abi: true,
  fd_pread: function(fd, iov, iovcnt, offset, pnum) {
    if (isNaN(offset)) return 27; // WASI EFBIG
    return krkrReadv(fd, iov, iovcnt, offset, pnum);
  }
});
