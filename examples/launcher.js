/**
 * ProductAddGrid — reference launcher.
 *
 * Opens the Custom Page hosting the control as a dialog, then acts on what the
 * control left behind once the dialog closes. The control localises its own
 * messages, so this bridge only has to display them.
 *
 * Wire `launchProductAddGrid` to a ribbon button, passing the primary control's
 * record id and entity type name.
 */
var ProductAddGrid = ProductAddGrid || {};

(function () {
  'use strict';

  /** Logical name of the Custom Page hosting the control. */
  var CUSTOM_PAGE_NAME = 'your_addproductsdialog';

  var SAVED_FLAG_PREFIX = 'productaddgrid_saved_';
  var NOTIFICATIONS_PREFIX = 'productaddgrid_notifications_';

  /** Xrm.App.sendAppNotification constants, keyed by the level the control emits. */
  var NOTIFICATION_TITLES = { 1: 'Success', 2: 'Warning', 3: 'Error', 4: 'Information' };
  var NOTIFICATION_ICONS = { 1: 100000001, 2: 100000003, 3: 100000002, 4: 100000000 };
  var TOAST_TYPE = 200000000;

  /**
   * Build the control's `parentRecordId` input: "<guid>|<variantKey>|<flags>".
   * Empty segments are allowed, so "guid||sc=0" sets a flag without a variant.
   */
  function encodeRecordId(recordId, variantKey, flags) {
    if (!variantKey && !flags) return recordId;
    return recordId + '|' + (variantKey || '') + (flags ? '|' + flags : '');
  }

  /** Resolve once the form is clean; reject if the save fails or the user cancels. */
  function saveParentFormIfDirty() {
    var result = Xrm.Page.data.save();
    return result && typeof result.then === 'function' ? result : Promise.resolve();
  }

  function openDialog(entityTypeName, encodedRecordId, widthPercent) {
    return Xrm.Navigation.navigateTo(
      {
        pageType: 'custom',
        name: CUSTOM_PAGE_NAME,
        entityName: entityTypeName,   // arrives as Param("entityName")
        recordId: encodedRecordId     // arrives as Param("recordId")
      },
      {
        target: 2,   // dialog
        position: 1, // center
        width: { value: widthPercent || 100, unit: '%' }
      }
    );
  }

  /**
   * The control writes a saved-flag only when it actually persisted something,
   * so a cancelled dialog costs no refresh.
   */
  function handleDialogResult(recordId) {
    var savedKey = SAVED_FLAG_PREFIX + recordId;

    if (localStorage.getItem(savedKey)) {
      localStorage.removeItem(savedKey);

      // Let any other frame on this origin (e.g. an embedded grid) refresh too.
      if (typeof BroadcastChannel !== 'undefined') {
        var channel = new BroadcastChannel('productgrid');
        channel.postMessage({ type: 'productgrid_refresh', parentId: recordId });
        channel.close();
      }

      // Refresh the parent so totals recalculate and field requirements re-evaluate.
      Xrm.Page.data.refresh(false).catch(function (error) {
        console.warn('[ProductAddGrid] parent refresh failed:', error);
      });
    }

    displayNotifications(recordId);
  }

  /** Messages arrive pre-localised from the control; just surface them. */
  function displayNotifications(recordId) {
    var key = NOTIFICATIONS_PREFIX + recordId;
    var payload = localStorage.getItem(key);
    if (!payload) return;

    localStorage.removeItem(key);

    var notifications;
    try {
      notifications = JSON.parse(payload);
    } catch (error) {
      console.warn('[ProductAddGrid] unparseable notification payload:', error);
      return;
    }
    if (!Array.isArray(notifications)) return;

    var userId = Xrm.Utility.getGlobalContext().userSettings.userId.replace(/[{}]/g, '');

    notifications.forEach(function (notification) {
      if (!notification.message) return;
      var level = notification.level in NOTIFICATION_TITLES ? notification.level : 4;

      Xrm.App.sendAppNotification({
        title: NOTIFICATION_TITLES[level],
        recipient: userId,
        body: notification.message,
        iconType: NOTIFICATION_ICONS[level],
        toastType: TOAST_TYPE
      }).catch(function (error) {
        console.warn('[ProductAddGrid] notification failed:', error);
      });
    });
  }

  /**
   * @param {string} recordId       Parent record GUID (unencoded).
   * @param {string} entityTypeName Parent entity logical name.
   * @param {string} [variantKey]   Selects an entity variant, when configured.
   * @param {string} [flags]        Override flags, e.g. "sc=0" to skip stock checks.
   */
  this.launchProductAddGrid = function (recordId, entityTypeName, variantKey, flags) {
    // Save first: the control reads the parent from Dataverse, not from the form.
    saveParentFormIfDirty()
      .then(function () {
        return openDialog(entityTypeName, encodeRecordId(recordId, variantKey, flags));
      })
      .then(function () {
        handleDialogResult(recordId); // unencoded — the control keys storage by bare GUID
      })
      .catch(function (error) {
        console.warn('[ProductAddGrid] launch aborted:', error);
      });
  };
}).call(ProductAddGrid);
