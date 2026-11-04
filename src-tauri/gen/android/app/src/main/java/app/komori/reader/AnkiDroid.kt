package app.komori.reader

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.DeadObjectException
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Why an action got no answer: `code` is what the native core tells apart. */
class AnkiDroidException(val code: String, message: String?) : Exception(message)

/**
 * The AnkiConnect actions Komori's Anki core sends (`src-tauri/src/anki.rs`), answered from
 * AnkiDroid's content provider, with AnkiConnect's results. AnkiDroid stores media under names
 * of its own, which `storeMediaFile` returns.
 */
class AnkiDroid(private val context: Context) {
  companion object {
    const val PACKAGE = "com.ichi2.anki"
    const val PERMISSION = "com.ichi2.anki.permission.READ_WRITE_DATABASE"
    private const val AUTHORITY = "content://com.ichi2.anki.flashcards"
    private val NOTES = Uri.parse("$AUTHORITY/notes")
    private val MODELS = Uri.parse("$AUTHORITY/models")
    private val DECKS = Uri.parse("$AUTHORITY/decks")
    private val CARDS = Uri.parse("$AUTHORITY/cards")
    private val MEDIA = Uri.parse("$AUTHORITY/media")
    private val SELECTED_DECK = Uri.parse("$AUTHORITY/selected_deck")
    private const val SEPARATOR = "\u001f"
    /** AnkiConnect's own words, which the native core recognizes. */
    private const val DUPLICATE = "cannot create note because it is a duplicate"
  }

  private val resolver get() = context.contentResolver

  fun installed(): Boolean =
    try {
      context.packageManager.getPackageInfo(PACKAGE, 0)
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }

  fun allowed(): Boolean =
    ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED

  /** One action's result, or the reason it has none. */
  fun call(action: String, params: JSONObject): Any {
    if (!installed()) throw AnkiDroidException("notInstalled", "AnkiDroid is not installed.")
    if (!allowed()) throw AnkiDroidException("notAllowed", "AnkiDroid's permission is not granted.")
    try {
      return answer(action, params)
    } catch (error: AnkiDroidException) {
      throw error
    } catch (error: SecurityException) {
      throw AnkiDroidException("notAllowed", error.message)
    } catch (error: IllegalStateException) {
      // AnkiDroid has no collection open until its first-run setup is done.
      throw AnkiDroidException("notReady", error.message)
    } catch (error: DeadObjectException) {
      throw AnkiDroidException("unavailable", error.message)
    } catch (error: Exception) {
      throw AnkiDroidException("rejected", error.message)
    }
  }

  private fun answer(action: String, params: JSONObject): Any =
    when (action) {
      "version" -> {
        models()
        6
      }
      "deckNamesAndIds" -> JSONObject().apply { for ((name, id) in decks()) put(name, id) }
      "modelNamesAndIds" -> JSONObject().apply { for ((name, id) in models()) put(name, id) }
      "modelFieldNames" -> JSONArray(fieldNames(modelId(params.getString("modelName"))))
      "createModel" -> createModel(params)
      "createDeck" -> createDeck(params.getString("deck"))
      "findNotes" -> JSONArray(ids(NOTES, params.getString("query")))
      "findCards" -> JSONArray(ids(CARDS, params.getString("query")))
      "getDecks" -> getDecks(longs(params.getJSONArray("cards")))
      "cardsToNotes" ->
        JSONArray(longs(params.getJSONArray("cards")).map { card(it).first }.distinct().sorted())
      "notesInfo" -> JSONArray(longs(params.getJSONArray("notes")).map(::noteInfo))
      "addNote" -> addNote(params.getJSONObject("note"))
      "updateNoteFields" -> updateFields(params.getJSONObject("note"))
      "addTags" -> changeTags(params, add = true)
      "removeTags" -> changeTags(params, add = false)
      "storeMediaFile" -> storeMedia(params.getString("filename"), params.getString("data"))
      "guiBrowse" -> browse(params.getString("query"))
      "multi" -> multi(params.getJSONArray("actions"))
      else -> throw AnkiDroidException("rejected", "unsupported action")
    }

  /** Each action's result or error; AnkiDroid being unusable fails them all. */
  private fun multi(actions: JSONArray): JSONArray {
    val results = JSONArray()
    for (index in 0 until actions.length()) {
      val action = actions.getJSONObject(index)
      val result = JSONObject()
      try {
        result.put("result", call(action.getString("action"), action.optJSONObject("params") ?: JSONObject()))
        result.put("error", JSONObject.NULL)
      } catch (error: AnkiDroidException) {
        if (error.code != "rejected" && error.code != "duplicate") throw error
        result.put("result", JSONObject.NULL)
        result.put("error", error.message ?: error.code)
      }
      results.put(result)
    }
    return results
  }

  private inline fun <T> rows(cursor: Cursor?, read: (Cursor) -> T): List<T> {
    val found = mutableListOf<T>()
    cursor?.use { while (it.moveToNext()) found.add(read(it)) }
    return found
  }

  /**
   * The lists of decks and note types always have a cursor. Without a collection (AnkiDroid's
   * first-run setup not done, or its storage not allowed) AnkiDroid fails inside its own process
   * and the query answers nothing.
   */
  private fun listed(uri: Uri, columns: Array<String>): Cursor =
    resolver.query(uri, columns, null, null, null)
      ?: throw AnkiDroidException("notReady", "AnkiDroid has no collection open.")

  private fun decks(): Map<String, Long> =
    rows(listed(DECKS, arrayOf("deck_name", "deck_id"))) {
      it.getString(0) to it.getLong(1)
    }.toMap()

  private fun models(): Map<String, Long> =
    rows(listed(MODELS, arrayOf("_id", "name"))) {
      it.getString(1) to it.getLong(0)
    }.toMap()

  private fun modelId(name: String): Long =
    models()[name] ?: throw AnkiDroidException("rejected", "model was not found: $name")

  private fun fieldNames(modelId: Long): List<String> =
    rows(resolver.query(Uri.withAppendedPath(MODELS, modelId.toString()), arrayOf("field_names"), null, null, null)) {
      it.getString(0)
    }.firstOrNull()?.split(SEPARATOR)
      ?: throw AnkiDroidException("rejected", "model was not found: $modelId")

  private fun modelName(modelId: Long): String =
    models().entries.firstOrNull { it.value == modelId }?.key ?: ""

  /** A note type with the given fields, styling and card templates, in that order. */
  private fun createModel(params: JSONObject): Any {
    val name = params.getString("modelName")
    if (models().containsKey(name)) throw AnkiDroidException("rejected", "Model name already exists")
    val fields = params.getJSONArray("inOrderFields").let { array -> List(array.length()) { array.getString(it) } }
    val templates = params.getJSONArray("cardTemplates")
    val created = resolver.insert(
      MODELS,
      ContentValues().apply {
        put("name", name)
        put("field_names", fields.joinToString(SEPARATOR))
        put("num_cards", templates.length())
        put("css", params.optString("css", ""))
        put("sort_field_index", 0)
        put("type", if (params.optBoolean("isCloze", false)) 1 else 0)
      },
    ) ?: throw AnkiDroidException("rejected", "the note type was not created")
    for (index in 0 until templates.length()) {
      val template = templates.getJSONObject(index)
      resolver.update(
        Uri.withAppendedPath(created, "templates/$index"),
        ContentValues().apply {
          put("card_template_name", template.optString("Name", "Card ${index + 1}"))
          put("question_format", template.getString("Front"))
          put("answer_format", template.getString("Back"))
        },
        null,
        null,
      )
    }
    return JSONObject().put("id", created.lastPathSegment?.toLong())
  }

  private fun createDeck(name: String): Long {
    decks()[name]?.let { return it }
    val created = resolver.insert(DECKS, ContentValues().apply { put("deck_name", name) })
    return created?.lastPathSegment?.toLongOrNull()
      ?: throw AnkiDroidException("rejected", "the deck was not created")
  }

  /** The notes or cards an Anki search finds. */
  private fun ids(uri: Uri, query: String): List<Long> =
    rows(resolver.query(uri, arrayOf("_id"), query, null, null)) { it.getLong(0) }

  /** A card's note and deck. */
  private fun card(id: Long): Pair<Long, Long> =
    rows(resolver.query(Uri.withAppendedPath(CARDS, id.toString()), arrayOf("note_id", "deck_id"), null, null, null)) {
      it.getLong(0) to it.getLong(1)
    }.firstOrNull() ?: throw AnkiDroidException("rejected", "card was not found: $id")

  private fun getDecks(cards: List<Long>): JSONObject {
    val names = decks().entries.associate { (name, id) -> id to name }
    val result = JSONObject()
    for (id in cards) {
      val deck = names[card(id).second] ?: continue
      val ids = result.optJSONArray(deck) ?: JSONArray().also { result.put(deck, it) }
      ids.put(id)
    }
    return result
  }

  private data class Note(val id: Long, val modelId: Long, val fields: List<String>, val tags: String)

  private fun note(id: Long): Note? =
    rows(resolver.query(Uri.withAppendedPath(NOTES, id.toString()), arrayOf("_id", "mid", "flds", "tags"), null, null, null)) {
      Note(it.getLong(0), it.getLong(1), it.getString(2).split(SEPARATOR), it.getString(3) ?: "")
    }.firstOrNull()

  /** As AnkiConnect: an empty object for a note that no longer exists. */
  private fun noteInfo(id: Long): JSONObject {
    val note = note(id) ?: return JSONObject()
    val names = fieldNames(note.modelId)
    val fields = JSONObject()
    names.forEachIndexed { order, name ->
      fields.put(name, JSONObject().put("value", note.fields.getOrElse(order) { "" }).put("order", order))
    }
    return JSONObject()
      .put("noteId", note.id)
      .put("modelName", modelName(note.modelId))
      .put("tags", JSONArray(tagList(note.tags)))
      .put("fields", fields)
  }

  private fun tagList(tags: String) = tags.split(' ').filter { it.isNotBlank() }

  private fun quoted(term: String) = "\"" + term.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

  private fun addNote(note: JSONObject): Long {
    val modelId = modelId(note.getString("modelName"))
    val deckName = note.getString("deckName")
    val deckId = decks()[deckName] ?: throw AnkiDroidException("rejected", "deck was not found: $deckName")
    val names = fieldNames(modelId)
    val given = note.getJSONObject("fields")
    val fields = names.map { given.optString(it, "") }
    if (fields.first().isBlank()) throw AnkiDroidException("rejected", "cannot create note because it is empty")
    val options = note.optJSONObject("options") ?: JSONObject()
    if (!options.optBoolean("allowDuplicate", false) && duplicate(modelId, fields.first(), options, deckName)) {
      throw AnkiDroidException("duplicate", DUPLICATE)
    }
    val tags = note.optJSONArray("tags")?.let { array -> List(array.length()) { array.getString(it) } } ?: emptyList()
    val created = resolver.insert(
      NOTES,
      ContentValues().apply {
        put("mid", modelId)
        put("flds", fields.joinToString(SEPARATOR))
        put("tags", tags.joinToString(" "))
      },
    ) ?: throw AnkiDroidException("rejected", "the note was not added")
    // AnkiDroid adds a note's cards to its note type's deck; they move to the chosen one.
    val cards = Uri.withAppendedPath(created, "cards")
    for ((ord, deck) in rows(resolver.query(cards, arrayOf("ord", "deck_id"), null, null, null)) { it.getInt(0) to it.getLong(1) }) {
      if (deck != deckId) {
        resolver.update(Uri.withAppendedPath(cards, ord.toString()), ContentValues().apply { put("deck_id", deckId) }, null, null)
      }
    }
    return created.lastPathSegment!!.toLong()
  }

  /** Anki's own duplicate search: the same first field in the collection, or in the deck. */
  private fun duplicate(modelId: Long, first: String, options: JSONObject, deckName: String): Boolean {
    val search = quoted("dupe:$modelId,$first")
    if (options.optString("duplicateScope") != "deck") return ids(NOTES, search).isNotEmpty()
    val scope = options.optJSONObject("duplicateScopeOptions")
    val deck = scope?.optString("deckName")?.takeIf { it.isNotEmpty() } ?: deckName
    val children = scope?.optBoolean("checkChildren", false) ?: false
    val names = decks().entries.associate { (name, id) -> id to name }
    return ids(CARDS, "$search ${quoted("deck:$deck")}").any { id ->
      val name = names[card(id).second]
      name == deck || (children && name?.startsWith("$deck::") == true)
    }
  }

  private fun updateFields(given: JSONObject): Any {
    val id = given.getLong("id")
    val note = note(id) ?: throw AnkiDroidException("rejected", "note was not found: $id")
    val fields = given.getJSONObject("fields")
    val values = fieldNames(note.modelId).mapIndexed { index, name ->
      if (fields.has(name)) fields.getString(name) else note.fields.getOrElse(index) { "" }
    }
    resolver.update(Uri.withAppendedPath(NOTES, id.toString()), ContentValues().apply { put("flds", values.joinToString(SEPARATOR)) }, null, null)
    return JSONObject.NULL
  }

  private fun changeTags(params: JSONObject, add: Boolean): Any {
    val changed = tagList(params.getString("tags"))
    for (id in longs(params.getJSONArray("notes"))) {
      val note = note(id) ?: continue
      val tags = tagList(note.tags)
      val next =
        if (add) tags + changed.filter { tag -> tags.none { it.equals(tag, ignoreCase = true) } }
        else tags.filter { tag -> changed.none { it.equals(tag, ignoreCase = true) } }
      if (next != tags) {
        resolver.update(Uri.withAppendedPath(NOTES, id.toString()), ContentValues().apply { put("tags", next.joinToString(" ")) }, null, null)
      }
    }
    return JSONObject.NULL
  }

  /**
   * Hands AnkiDroid the file through Komori's file provider, readable by AnkiDroid only while
   * it copies it. AnkiDroid keeps it as `<name>_<digits>.<extension>` and that name is returned.
   */
  private fun storeMedia(filename: String, data: String): String {
    if (filename.isEmpty() || filename.contains('/') || filename.contains('\\')) {
      throw AnkiDroidException("rejected", "invalid file name")
    }
    val folder = File(context.cacheDir, "ankidroid").apply { mkdirs() }
    val file = File(folder, filename)
    try {
      file.writeBytes(Base64.decode(data, Base64.DEFAULT))
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
      context.grantUriPermission(PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try {
        val stored = resolver.insert(
          MEDIA,
          ContentValues().apply {
            put("file_uri", uri.toString())
            put("preferred_name", filename.substringBeforeLast('.').replace(' ', '_'))
          },
        )
        return stored?.path?.let { File(it).name }?.takeIf { it.isNotEmpty() }
          ?: throw AnkiDroidException("rejected", "the file was not stored")
      } finally {
        context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    } finally {
      file.delete()
    }
  }

  /**
   * AnkiDroid's card browser, searching for the given notes. The browser lists only AnkiDroid's
   * current deck unless the reader chose All decks there, so the notes' deck becomes the current one.
   */
  private fun browse(query: String): Any {
    ids(CARDS, query).firstOrNull()?.let { id ->
      val deck = ContentValues().apply { put("deck_id", card(id).second) }
      resolver.update(SELECTED_DECK, deck, null, null)
    }
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("anki://x-callback-url/browser?search=" + Uri.encode(query)))
      .setPackage(PACKAGE)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    return JSONArray()
  }

  private fun longs(array: JSONArray) = List(array.length()) { array.getLong(it) }
}
