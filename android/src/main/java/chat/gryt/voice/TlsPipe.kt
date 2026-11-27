package chat.gryt.voice

import android.os.ParcelFileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

/** wss:// for native/core/tls_android.c: Android's TLS, checked against the system trust store and the host name. */
object TlsPipe {
  /** C's end of a socket pair the TLS is pumped through, or -1. Called from the engine's receive thread. */
  @JvmStatic fun open(host: String, port: Int, timeoutMs: Int): Int {
    val tcp = Socket()
    return try {
      tcp.tcpNoDelay = true
      tcp.connect(InetSocketAddress(host, port), timeoutMs)
      tcp.soTimeout = timeoutMs
      val tls = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(tcp, host, port, true) as SSLSocket
      tls.startHandshake()
      if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, tls.session)) throw javax.net.ssl.SSLPeerUnverifiedException(host)
      tls.soTimeout = 0
      val (ours, theirs) = ParcelFileDescriptor.createSocketPair()
      val done = {
        runCatching { tls.close() }
        runCatching { ours.close() }
      }
      thread(isDaemon = true, name = "gryt-tls-out") {
        runCatching { FileInputStream(ours.fileDescriptor).copyTo(tls.outputStream) }
        done()
      }
      thread(isDaemon = true, name = "gryt-tls-in") {
        runCatching { tls.inputStream.copyTo(FileOutputStream(ours.fileDescriptor)) }
        done()
      }
      theirs.detachFd()
    } catch (e: Exception) {
      runCatching { tcp.close() }
      -1
    }
  }
}
