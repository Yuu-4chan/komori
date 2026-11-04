package app.komori.reader

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.FileNotFoundException
import java.util.concurrent.Executors

@InvokeArg
class PickArgs {
  var multiple: Boolean = false
  /** Dictionary archives, read once to import, instead of books, whose permission is kept. */
  var dictionaries: Boolean = false
}

@InvokeArg
class DocumentArgs {
  lateinit var uri: String
}

@InvokeArg
class AssetArgs {
  lateinit var path: String
}

@InvokeArg
class SystemBarsArgs {
  var shown: Boolean = true
}

@InvokeArg
class BarIconsArgs {
  var dark: Boolean = true
}

@InvokeArg
class CopyTextArgs {
  var text: String = ""
}

@InvokeArg
class BookSelectionArgs {
  var own: Boolean = false
}

@InvokeArg
class AnkiArgs {
  lateinit var action: String
}

@InvokeArg
class KeepArgs {
  var uris: List<String> = emptyList()
}

/**
 * Komori's own Android plugin, called only from the native core (`src-tauri/src/android.rs`).
 * Books are linked, never copied: the picker's read permission is kept, and each read opens the
 * original document read-only and hands its descriptor to the native core. Dictionary archives
 * are read the same way, once, without keeping their permission. Anki cards go to AnkiDroid.
 */
@TauriPlugin(permissions = [Permission(strings = [AnkiDroid.PERMISSION], alias = "ankidroid")])
class KomoriPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private val ankiDroid by lazy { AnkiDroid(activity.applicationContext) }
  /** AnkiDroid answers off the main thread, one action at a time. */
  private val ankiWork = Executors.newSingleThreadExecutor()

  /**
   * Komori draws under the status bar, the display cutout and the gesture bar; the page keeps
   * its controls clear of them. Each change reaches it as a `komori-insets` event.
   */
  override fun load(webView: WebView) {
    super.load(webView)
    this.webView = webView
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val script = "window.dispatchEvent(new CustomEvent('komori-insets', { detail: ${cssInsets(insets)} }))"
      view.post { webView.evaluateJavascript(script, null) }
      ViewCompat.onApplyWindowInsets(view, insets)
    }
  }

  /** The current insets, in CSS pixels. */
  @Command
  fun insets(invoke: Invoke) {
    val view = webView
    val insets = view?.let { ViewCompat.getRootWindowInsets(it) }
    invoke.resolve(if (insets == null) JSObject() else cssInsets(insets))
  }

  /** Hides the status and navigation bars while reading; a swipe from an edge shows them. */
  @Command
  fun systemBars(invoke: Invoke) {
    val shown = invoke.parseArgs(SystemBarsArgs::class.java).shown
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      if (shown) controller.show(WindowInsetsCompat.Type.systemBars())
      else controller.hide(WindowInsetsCompat.Type.systemBars())
      invoke.resolve()
    }
  }

  /**
   * Draws the bars' icons dark over a light page and light over a dark one. Android picks them
   * from its own dark mode otherwise, whatever Komori's theme.
   */
  @Command
  fun systemBarIcons(invoke: Invoke) {
    val dark = invoke.parseArgs(BarIconsArgs::class.java).dark
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = dark
      controller.isAppearanceLightNavigationBars = dark
      invoke.resolve()
    }
  }

  /** Whether a selection made now is the book's, which shows Komori's toolbar, not Android's. */
  @Command
  fun bookSelection(invoke: Invoke) {
    BookSelection.own = invoke.parseArgs(BookSelectionArgs::class.java).own
    invoke.resolve()
  }

  /** Puts plain text on Android's clipboard, which the WebView's clipboard API may not write. */
  @Command
  fun copyText(invoke: Invoke) {
    val text = invoke.parseArgs(CopyTextArgs::class.java).text
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Komori", text))
    invoke.resolve()
  }

  /**
   * The bars' and cutout's insets as they are now, and `stable`, as they are with the bars
   * shown: the Reader lays the book out in the stable area, so hiding the bars moves nothing.
   */
  private fun cssInsets(insets: WindowInsetsCompat): JSObject {
    val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
    val shown = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val stable = Insets.max(insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars()), cutout)
    val density = activity.resources.displayMetrics.density
    fun css(sides: Insets) = JSObject().apply {
      put("top", (sides.top / density).toDouble())
      put("right", (sides.right / density).toDouble())
      put("bottom", (sides.bottom / density).toDouble())
      put("left", (sides.left / density).toDouble())
    }
    return css(shown).apply { put("stable", css(stable)) }
  }

  @Command
  fun pick(invoke: Invoke) {
    val args = invoke.parseArgs(PickArgs::class.java)
    // Many providers list EPUBs and ZIP archives as plain binary files.
    val types =
      if (args.dictionaries) arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")
      else arrayOf("application/epub+zip", "application/octet-stream")
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_MIME_TYPES, types)
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
    }
    startActivityForResult(invoke, intent, if (args.dictionaries) "pickedArchives" else "picked")
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) = resolvePicked(invoke, result, true)

  /** Dictionary archives keep no permission: the picker's grant lasts long enough to import them. */
  @ActivityCallback
  fun pickedArchives(invoke: Invoke, result: ActivityResult) = resolvePicked(invoke, result, false)

  private fun resolvePicked(invoke: Invoke, result: ActivityResult, keep: Boolean) {
    val data = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      invoke.resolve(JSObject().apply { put("canceled", true) })
      return
    }
    val uris = mutableListOf<Uri>()
    val clip = data.clipData
    if (clip != null) {
      for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri)
    } else {
      data.data?.let { uris.add(it) }
    }
    val documents = JSArray()
    for (uri in uris) {
      // A provider that cannot keep the permission is still read now; the book then shows as
      // missing after a restart, with Relink.
      if (keep) try {
        activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: SecurityException) {
      }
      documents.put(JSObject().apply {
        put("uri", uri.toString())
        put("name", displayName(uri))
      })
    }
    invoke.resolve(JSObject().apply {
      put("canceled", false)
      put("documents", documents)
    })
  }

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(DocumentArgs::class.java)
    try {
      val descriptor = activity.contentResolver.openFileDescriptor(Uri.parse(args.uri), "r")
      if (descriptor == null) {
        invoke.reject("The document could not be opened.", "unreadable")
        return
      }
      invoke.resolve(JSObject().apply { put("fd", descriptor.detachFd()) })
    } catch (error: FileNotFoundException) {
      invoke.reject(error.message, "missing")
    } catch (error: SecurityException) {
      invoke.reject(error.message, "denied")
    } catch (error: Exception) {
      invoke.reject(error.message, "unreadable")
    }
  }

  /**
   * An asset the APK keeps uncompressed, such as an included Reader font: a descriptor of the APK
   * and where in it the asset is.
   */
  @Command
  fun openAsset(invoke: Invoke) {
    val args = invoke.parseArgs(AssetArgs::class.java)
    try {
      activity.assets.openFd(args.path).use { asset ->
        invoke.resolve(JSObject().apply {
          put("fd", ParcelFileDescriptor.dup(asset.fileDescriptor).detachFd())
          put("offset", asset.startOffset)
          put("length", asset.length)
        })
      }
    } catch (error: Exception) {
      invoke.reject(error.message, "missing")
    }
  }

  /** Gives back the permission of every document the catalog no longer links. */
  @Command
  fun keepOnly(invoke: Invoke) {
    val kept = invoke.parseArgs(KeepArgs::class.java).uris.toSet()
    for (permission in activity.contentResolver.persistedUriPermissions) {
      if (permission.uri.toString() in kept) continue
      try {
        activity.contentResolver.releasePersistableUriPermission(
          permission.uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
      } catch (_: SecurityException) {
      }
    }
    invoke.resolve()
  }

  /** One AnkiConnect action, as `{ result }`, or rejected with why AnkiDroid could not answer. */
  @Command
  fun anki(invoke: Invoke) {
    val action = invoke.parseArgs(AnkiArgs::class.java).action
    val params = invoke.getArgs().optJSONObject("params") ?: JSObject()
    ankiWork.execute {
      try {
        invoke.resolve(JSObject().apply { put("result", ankiDroid.call(action, params)) })
      } catch (error: AnkiDroidException) {
        invoke.reject(error.message, error.code)
      }
    }
  }

  /**
   * Asks for AnkiDroid's permission. Once Android no longer asks (denied twice), Komori's app
   * settings open instead, where it can still be allowed.
   */
  @Command
  fun ankiAllow(invoke: Invoke) {
    if (!ankiDroid.installed()) {
      invoke.reject("AnkiDroid is not installed.", "notInstalled")
      return
    }
    if (ankiDroid.allowed()) {
      invoke.resolve(JSObject().apply { put("allowed", true) })
      return
    }
    val saved = activity.getSharedPreferences("komori", Context.MODE_PRIVATE)
    if (saved.getBoolean("ankidroidAsked", false) &&
      !ActivityCompat.shouldShowRequestPermissionRationale(activity, AnkiDroid.PERMISSION)
    ) {
      activity.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)),
      )
      invoke.resolve(JSObject().apply { put("allowed", false) })
      return
    }
    saved.edit().putBoolean("ankidroidAsked", true).apply()
    requestPermissionForAlias("ankidroid", invoke, "ankiAllowed")
  }

  @PermissionCallback
  fun ankiAllowed(invoke: Invoke) {
    invoke.resolve(JSObject().apply { put("allowed", ankiDroid.allowed()) })
  }

  /** AnkiDroid's page in the Play Store, or on the web without one. */
  @Command
  fun ankiStore(invoke: Invoke) {
    val page = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${AnkiDroid.PACKAGE}"))
    try {
      activity.startActivity(page)
    } catch (_: Exception) {
      activity.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=${AnkiDroid.PACKAGE}")),
      )
    }
    invoke.resolve()
  }

  /** Back from the Library leaves Komori as Android's own apps do: to the background. */
  @Command
  fun leave(invoke: Invoke) {
    invoke.resolve()
    activity.moveTaskToBack(true)
  }

  private fun displayName(uri: Uri): String {
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0)
        }
    } catch (_: Exception) {
    }
    return uri.lastPathSegment?.substringAfterLast('/') ?: "Untitled.epub"
  }
}
