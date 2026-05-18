{
  description = "Voxal MCP Server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "voxal";
          version = "1.0.0";

          src = ./.;

          npmDepsHash = "sha256-tp4xz3xuuRUCjUQ2iM5qa/RqudRucZypt1MWCInff9w=";
          nodejs = pkgs.nodejs_22;
        };
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            ffmpeg
          ];

          shellHook = ''
            echo "🎙️ Voxal MCP Development Environment"
            echo "Node.js version: $(node --version)"
          '';
        };
      }
    );
}
