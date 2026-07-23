#!/bin/bash
# MobileIDE Runtime Preparation Script
# Downloads and prepares ARM64 Android binaries for the runtime

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/../../android/app/src/main/assets/runtime"
BIN_DIR="$RUNTIME_DIR/bin"
LIB_DIR="$RUNTIME_DIR/lib"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}MobileIDE Runtime Preparation${NC}"
echo "=============================="

# Create directories
mkdir -p "$BIN_DIR"
mkdir -p "$LIB_DIR"

echo -e "${YELLOW}Creating placeholder runtime...${NC}"
echo "Note: For production, download real ARM64 Android binaries"

# Create placeholder bash script
cat > "$BIN_DIR/bash" << 'EOF'
#!/system/bin/sh
# MobileIDE Bash wrapper
exec /system/bin/sh "$@"
EOF

# Create placeholder sh
cat > "$BIN_DIR/sh" << 'EOF'
#!/system/bin/sh
exec /system/bin/sh "$@"
EOF

# Create placeholder node
cat > "$BIN_DIR/node" << 'EOF'
#!/system/bin/sh
echo "MobileIDE Node.js Runtime"
echo "Node placeholder - bundle real node binary for production"
echo "Version: v20.0.0-mobileide"
EOF

# Create placeholder npm
cat > "$BIN_DIR/npm" << 'EOF'
#!/system/bin/sh
echo "npm placeholder - bundle real npm for production"
EOF

# Create placeholder npx
cat > "$BIN_DIR/npx" << 'EOF'
#!/system/bin/sh
echo "npx placeholder - bundle real npx for production"
EOF

# Create placeholder pnpm
cat > "$BIN_DIR/pnpm" << 'EOF'
#!/system/bin/sh
echo "pnpm placeholder - bundle real pnpm for production"
EOF

# Create placeholder git
cat > "$BIN_DIR/git" << 'EOF'
#!/system/bin/sh
echo "git placeholder - bundle real git for production"
EOF

# Create common utility wrappers
for cmd in ls cat mkdir rm cp mv grep echo pwd clear; do
    cat > "$BIN_DIR/$cmd" << EOF
#!/system/bin/sh
exec /system/bin/$cmd "\$@" 2>/dev/null || echo "$cmd: command available"
EOF
done

# Set executable permissions
chmod +x "$BIN_DIR"/*

echo -e "${GREEN}Runtime preparation complete!${NC}"
echo ""
echo "Runtime location: $RUNTIME_DIR"
echo ""
echo -e "${YELLOW}IMPORTANT:${NC}"
echo "For production use, replace placeholder binaries with real ARM64 Android binaries:"
echo "  - Node.js: https://nodejs.org/en/download (or build from source with NDK)"
echo "  - Bash: Build from termux-packages or use static build"
echo "  - Git: Build from source with NDK or use termux-packages"
echo "  - Core utils: Use toybox or busybox static builds"
echo ""
echo "Binaries must be compiled for aarch64-linux-android (ARM64)"
