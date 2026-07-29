{
  "targets": [
    {
      "target_name": "addon",
      "sources": ["addon.cc"],
      "include_dirs": ["<!(node -e \"require('nan')\")"],
      "cflags_cc": ["-std=c++17"]
    }
  ]
}
