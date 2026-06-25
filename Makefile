.PHONY: help pub install analyze lint fix test test-cov clean run \
        build-apk build-appbundle build-ios build-windows build-linux build-macos build-all \
        outdated upgrade gen

APP_NAME := Moke
VERSION := $(shell grep '^version:' pubspec.yaml | head -1 | awk '{print $$2}' | tr '+' '-')

help:
	@echo "Moke - Flutter 项目构建工具"
	@echo ""
	@echo "开发命令:"
	@echo "  make pub           安装依赖 (flutter pub get)"
	@echo "  make analyze       静态代码分析 (flutter analyze)"
	@echo "  make fix           自动修复 Dart 代码问题 (dart fix --apply)"
	@echo "  make test          运行单元测试"
	@echo "  make test-cov      运行测试并生成覆盖率报告"
	@echo "  make run           启动应用 (需要已连接设备/模拟器)"
	@echo "  make clean         清理构建缓存"
	@echo ""
	@echo "构建命令:"
	@echo "  make build-apk         构建 Android APK (debug)"
	@echo "  make build-apk-release 构建 Android APK (release)"
	@echo "  make build-appbundle    构建 Android App Bundle"
	@echo "  make build-ios          构建 iOS"
	@echo "  make build-windows      构建 Windows"
	@echo "  make build-linux        构建 Linux"
	@echo "  make build-macos        构建 macOS"
	@echo "  make build-all          构建当前平台版本"
	@echo ""
	@echo "维护命令:"
	@echo "  make outdated       检查可更新的依赖"
	@echo "  make upgrade         升级依赖"
	@echo "  make gen             生成代码 (build_runner)"

pub install:
	flutter pub get

analyze lint:
	flutter analyze

fix:
	dart fix --apply

test:
	flutter test

test-cov:
	flutter test --coverage

clean:
	flutter clean
	rm -rf .dart_tool

run:
	flutter run

build-apk:
	flutter build apk --debug

build-apk-release:
	flutter build apk --release

build-appbundle:
	flutter build appbundle --release

build-ios:
	flutter build ios --release

build-windows:
	flutter build windows --release

build-linux:
	flutter build linux --release

build-macos:
	flutter build macos --release

build-all: build-apk-release

outdated:
	flutter pub outdated

upgrade:
	flutter pub upgrade --major-versions

gen:
	dart run build_runner build --delete-conflicting-outputs
