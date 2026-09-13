#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

// All calls originate on Electron's main thread. Keep the controller/delegate
// alive for the process lifetime; Sparkle owns its normal UI and installation.
@interface CueUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) NSString *error;
@end
@implementation CueUpdaterDelegate
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
    self.state = @"available";
    self.version = item.versionString;
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
    self.state = @"up-to-date";
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
    if (error.code == SUNoUpdateError) return;
    self.state = @"error";
    self.error = error.localizedDescription;
    NSLog(@"[cue] Sparkle: %@", error);
}
@end

static SPUStandardUpdaterController *controller;
static CueUpdaterDelegate *delegate;
static napi_value JSBoolean(napi_env env, bool value) {
    napi_value result; napi_get_boolean(env, value, &result); return result;
}
static bool OnMainThread(napi_env env) {
    if (NSThread.isMainThread) return true;
    napi_throw_error(env, nullptr, "Sparkle must run on the main thread"); return false;
}
static napi_value Start(napi_env env, napi_callback_info info) {
    if (!OnMainThread(env)) return nullptr;
    @autoreleasepool {
        if (controller) return JSBoolean(env, true);
        delegate = [CueUpdaterDelegate new];
        delegate.state = @"ready";
        controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:delegate userDriverDelegate:nil];
        NSError *error = nil;
        if (![controller.updater startUpdater:&error]) {
            controller = nil;
            napi_throw_error(env, nullptr, error.localizedDescription.UTF8String);
            return nullptr;
        }
        return JSBoolean(env, true);
    }
}
static napi_value Check(napi_env env, napi_callback_info info) {
    if (!OnMainThread(env)) return nullptr;
    if (!controller.updater.canCheckForUpdates) return JSBoolean(env, false);
    delegate.state = @"checking"; delegate.error = nil; delegate.version = nil;
    [controller checkForUpdates:nil];
    return JSBoolean(env, true);
}
static napi_value Probe(napi_env env, napi_callback_info info) {
    if (!OnMainThread(env)) return nullptr;
    if (!controller.updater.canCheckForUpdates) return JSBoolean(env, false);
    delegate.state = @"checking"; delegate.error = nil; delegate.version = nil;
    [controller.updater checkForUpdateInformation];
    return JSBoolean(env, true);
}
static napi_value Status(napi_env env, napi_callback_info info) {
    if (!OnMainThread(env)) return nullptr;
    napi_value result; napi_create_object(env, &result);
    NSDictionary *values = @{@"state": delegate.state ?: @"stopped",
                              @"version": delegate.version ?: @"",
                              @"error": delegate.error ?: @"",
                              @"feedURL": controller.updater.feedURL.absoluteString ?: @""};
    for (NSString *key in values) {
        napi_value value; napi_create_string_utf8(env, [values[key] UTF8String], NAPI_AUTO_LENGTH, &value);
        napi_set_named_property(env, result, key.UTF8String, value);
    }
    napi_set_named_property(env, result, "canCheck", JSBoolean(env, controller.updater.canCheckForUpdates));
    return result;
}
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"check", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, 4, methods);
    return exports;
}
NAPI_MODULE(cue_sparkle, Init)
