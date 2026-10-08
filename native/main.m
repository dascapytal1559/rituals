#import <Cocoa/Cocoa.h>
#import <fcntl.h>
#import <sys/file.h>
#import <sys/stat.h>
#import <unistd.h>
#import <signal.h>
#import <errno.h>

// The store folder and the Node.js binary are written into the built bundle's Info.plist by native/build.sh.
static NSString *AbsolutePathSetting(NSString *key) {
    id value = [[NSBundle mainBundle] objectForInfoDictionaryKey:key];
    return [value isKindOfClass:[NSString class]] && [value isAbsolutePath] ? value : nil;
}
static NSString *StoreRoot(void) { return AbsolutePathSetting(@"RitualStoreRoot"); }
static NSString *NodeBinary(void) { return AbsolutePathSetting(@"RitualNode"); }
static NSString *LogFolder(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/RitualDashboard"];
}
static void LogEvent(NSString *event) {
    NSString *path = [LogFolder() stringByAppendingPathComponent:@"app-host.log"];
    int fd = open(path.fileSystemRepresentation, O_CREAT|O_WRONLY|O_APPEND, 0600);
    if (fd >= 0) {
        NSString *line = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], event];
        NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
        write(fd, data.bytes, data.length); close(fd);
    }
}

@interface RitualApp : NSObject <NSApplicationDelegate>
@property(strong) NSStatusItem *statusItem;
@property(strong) NSMenuItem *stateItem;
@property(strong) NSMenuItem *retryItem;
@property(strong) NSTask *backend;
@property(strong) dispatch_source_t terminationSignal;
@property BOOL starting;
@property BOOL terminating;
@property int instanceLock;
@end

@implementation RitualApp
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    umask(0077);
    [[NSFileManager defaultManager] createDirectoryAtPath:LogFolder() withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:nil];
    NSString *lockPath = [LogFolder() stringByAppendingPathComponent:@"app-host.lock"];
    self.instanceLock = open(lockPath.fileSystemRepresentation, O_CREAT|O_RDWR|O_CLOEXEC, 0600);
    if (self.instanceLock < 0 || flock(self.instanceLock, LOCK_EX|LOCK_NB) != 0) {
        LogEvent(@"already_running"); [NSApp terminate:nil]; return;
    }
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    self.statusItem.button.image = [NSImage imageWithSystemSymbolName:@"checkmark.circle" accessibilityDescription:@"Ritual Dashboard"];
    self.statusItem.button.toolTip = @"Ritual Dashboard";
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Ritual Dashboard"];
    NSMenuItem *title = [[NSMenuItem alloc] initWithTitle:@"Ritual Dashboard" action:nil keyEquivalent:@""];
    title.enabled = NO; [menu addItem:title];
    self.stateItem = [[NSMenuItem alloc] initWithTitle:@"Starting…" action:nil keyEquivalent:@""];
    self.stateItem.enabled = NO; [menu addItem:self.stateItem];
    self.retryItem = [[NSMenuItem alloc] initWithTitle:@"Retry starting" action:@selector(startBackend:) keyEquivalent:@""];
    self.retryItem.target = self; [menu addItem:self.retryItem];
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit Ritual Dashboard" action:@selector(quit:) keyEquivalent:@"q"];
    quit.target = self; [menu addItem:quit]; self.statusItem.menu = menu;
    signal(SIGTERM, SIG_IGN);
    self.terminationSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    __weak RitualApp *weakSelf = self;
    dispatch_source_set_event_handler(self.terminationSignal, ^{ [weakSelf quit:nil]; });
    dispatch_resume(self.terminationSignal);
    LogEvent(@"named_app_started");
    [self startBackend:nil];
}
- (void)startBackend:(id)sender {
    (void)sender;
    if (self.starting || self.backend.running || self.terminating) return;
    self.starting = YES; self.retryItem.enabled = NO;
    self.stateItem.title = @"Checking database access…";
    LogEvent(@"requesting_database_read");
    __weak RitualApp *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *root = StoreRoot();
        NSString *node = NodeBinary();
        NSString *database = [root stringByAppendingPathComponent:@"data/ritual.sqlite3"];
        int fd = (root && node) ? open(database.fileSystemRepresentation, O_RDONLY) : -1;
        int failure = (root && node) ? (fd < 0 ? errno : 0) : ENOENT;
        BOOL valid = NO;
        if (fd >= 0) {
            char header[16] = {0};
            valid = read(fd, header, sizeof(header)) == sizeof(header) && memcmp(header, "SQLite format 3", 15) == 0;
            close(fd);
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            RitualApp *app = weakSelf;
            if (!app || app.terminating) return;
            app.starting = NO;
            if (failure || !valid) {
                app.retryItem.enabled = YES;
                app.stateItem.title = @"Database access needed";
                LogEvent([NSString stringWithFormat:@"database_read_failed errno=%d", failure]);
                NSAlert *alert = [[NSAlert alloc] init];
                alert.messageText = @"Ritual Dashboard could not read its database";
                alert.informativeText = ((StoreRoot() && NodeBinary()) ? @"Check that the store folder and its data/ritual.sqlite3 are available, then use Retry starting. No service has been started." : @"This build has no RitualStoreRoot or RitualNode. Rebuild it with native/build.sh OUTPUT_APP_PATH STORE_ROOT NODE. No service has been started.");
                [alert addButtonWithTitle:@"OK"];
                [alert runModal];
                return;
            }
            LogEvent(@"database_read_succeeded");
            [app launchBackend];
        });
    });
}
- (void)launchBackend {
    // bin/ritual-server execs the Node.js binary named at build time, so no PATH lookup happens under launchd.
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
    task.arguments = @[[StoreRoot() stringByAppendingPathComponent:@"bin/ritual-server"]];
    task.currentDirectoryURL = [NSURL fileURLWithPath:@"/"];
    NSMutableDictionary *environment = [[[NSProcessInfo processInfo] environment] mutableCopy];
    environment[@"RITUAL_NODE"] = NodeBinary();
    task.environment = environment;
    for (NSString *name in @[@"named-backend.out.log", @"named-backend.err.log"]) {
        NSString *path = [LogFolder() stringByAppendingPathComponent:name];
        int fd = open(path.fileSystemRepresentation, O_CREAT|O_WRONLY|O_APPEND, 0600);
        if (fd < 0) {
            self.stateItem.title = @"Could not open service log"; self.retryItem.enabled = YES;
            LogEvent(@"backend_log_open_failed"); return;
        }
        NSFileHandle *handle = [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
        if ([name containsString:@".out."]) task.standardOutput = handle;
        else task.standardError = handle;
    }
    __weak RitualApp *weakSelf = self;
    task.terminationHandler = ^(NSTask *finished) {
        dispatch_async(dispatch_get_main_queue(), ^{
            RitualApp *app = weakSelf;
            if (!app || app.terminating) return;
            LogEvent([NSString stringWithFormat:@"backend_stopped code=%d", finished.terminationStatus]);
            app.stateItem.title = @"Service stopped";
            app.retryItem.enabled = YES;
            app.backend = nil;
        });
    };
    self.backend = task;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        self.backend = nil; self.stateItem.title = @"Could not start service"; self.retryItem.enabled = YES;
        LogEvent(@"backend_launch_failed");
        return;
    }
    self.stateItem.title = @"Local service running"; self.retryItem.enabled = NO;
    LogEvent(@"backend_started");
}
- (void)quit:(id)sender { (void)sender; [NSApp terminate:nil]; }
- (void)applicationWillTerminate:(NSNotification *)notification {
    (void)notification; self.terminating = YES;
    if (self.backend.running) { [self.backend terminate]; [self.backend waitUntilExit]; }
    if (self.instanceLock >= 0) { close(self.instanceLock); self.instanceLock = -1; }
    LogEvent(@"named_app_stopped");
}
@end

int main(int argc, const char *argv[]) {
    (void)argc; (void)argv;
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        RitualApp *delegate = [[RitualApp alloc] init];
        delegate.instanceLock = -1; app.delegate = delegate;
        [app run];
    }
    return 0;
}
