import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PART_STYLES, INK_HEX, clamp as clampNumber, type ColorIndex } from './config';
import type { ReliefBuildData } from './parts';
import { buildSectionCaps } from './parts';


export type ViewMode = 'assembled' | 'exploded' | 'xray' | 'section';

export interface ViewerState {
  mode: ViewMode;
  selectedParts: ColorIndex[];
  explodeDistance: number;
  sectionY: number;
  showDots: boolean;
  showBoundaries: boolean;
  autoRotate: boolean;
}

interface PartVisual {
  group: THREE.Group;
  solid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  connector: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  dots: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  boundary: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  capGroup: THREE.Group;
  capMaterial: THREE.MeshStandardMaterial;
  capLineMaterial: THREE.LineBasicMaterial;
  capMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null;
  capLine: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  targetZ: number;
  explosionRank: number;
}

const CAMERA_HOME = new THREE.Vector3(104, -136, 105);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 11);

function disposeGeometry(geometry: THREE.BufferGeometry | null): void {
  geometry?.dispose();
}

function lineGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export class ReliefViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly partsRoot = new THREE.Group();
  private readonly partVisuals: PartVisual[] = [];
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 10000);
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private state: ViewerState = {
    mode: 'assembled',
    selectedParts: [],
    explodeDistance: 26,
    sectionY: 2,
    showDots: true,
    showBoundaries: true,
    autoRotate: false,
  };
  private data: ReliefBuildData | null = null;
  private ghostActive = false;
  private needsRender = true;
  private frameHandle: number | null = null;
  private readonly visibilityHandler: () => void;
  private sectionBuilt = false;
  private userMovedCamera = false;
  private disposed = false;
  private resizeTimeout: number | null = null;
  private savedExplodePose: {
    position: THREE.Vector3;
    target: THREE.Vector3;
  } | null = null;
  private cameraTransition: {
    fromPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPosition: THREE.Vector3;
    toTarget: THREE.Vector3;
    startedAt: number;
    duration: number;
  } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x070910, 260, 460);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.5, 700);
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(CAMERA_HOME);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(CAMERA_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.rotateSpeed = 0.66;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.7;
    this.controls.minDistance = 58;
    this.controls.maxDistance = 340;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.488;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true;
    });
    this.controls.addEventListener('change', () => {
      this.invalidate();
    });
    this.controls.update();

    this.setupLights();
    this.setupGround();
    this.setupParts();
    this.scene.add(this.partsRoot);

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.visibilityHandler = () => {
      if (document.hidden) {
        this.cancelFrame();
      } else {
        this.invalidate();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.requestFrame();
  }

  private setupLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xc7dcff, 0x281c2c, 0.95);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight(0xfff3dd, 3.35);
    key.position.set(-112, -74, 126);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 20;
    key.shadow.camera.far = 360;
    key.shadow.camera.left = -105;
    key.shadow.camera.right = 105;
    key.shadow.camera.top = 105;
    key.shadow.camera.bottom = -105;
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.025;
    key.target.position.set(0, 0, 6);
    this.scene.add(key.target);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8dc7ff, 1.18);
    rim.position.set(92, 104, 76);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffc4de, 0.32);
    fill.position.set(20, -60, -60);
    this.scene.add(fill);

    const low = new THREE.PointLight(0x82a7e4, 7, 220, 1.8);
    low.position.set(0, -100, 28);
    this.scene.add(low);
  }

  private setupGround(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(100, 128),
      new THREE.MeshStandardMaterial({
        color: 0x0f1420,
        roughness: 0.94,
        metalness: 0.08,
        transparent: true,
        opacity: 0.96,
      }),
    );
    floor.position.z = -1.84;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ringGeometry = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 180 }, (_, index) => {
        const angle = (index / 180) * Math.PI * 2;
        return new THREE.Vector3(
          Math.cos(angle) * 88,
          Math.sin(angle) * 88,
          -1.82,
        );
      }),
    );
    const ring = new THREE.LineLoop(
      ringGeometry,
      new THREE.LineBasicMaterial({
        color: 0x374357,
        transparent: true,
        opacity: 0.48,
      }),
    );
    this.scene.add(ring);

    const innerRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 160 }, (_, index) => {
          const angle = (index / 160) * Math.PI * 2;
          return new THREE.Vector3(
            Math.cos(angle) * 72,
            Math.sin(angle) * 72,
            -1.81,
          );
        }),
      ),
      new THREE.LineBasicMaterial({
        color: 0x252f41,
        transparent: true,
        opacity: 0.42,
      }),
    );
    this.scene.add(innerRing);

    const grid = new THREE.GridHelper(220, 22, 0x33405a, 0x1d2635);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -1.83;
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.25;
    gridMaterial.depthWrite = false;
    this.scene.add(grid);
  }

  private setupParts(): void {
    const ink = new THREE.Color(INK_HEX);

    for (let index = 0; index < PART_STYLES.length; index += 1) {
      const style = PART_STYLES[index];
      const group = new THREE.Group();
      group.name = `part-${style.key}`;

      const solidMaterial = new THREE.MeshPhysicalMaterial({
        color: style.colorHex,
        roughness: 0.43,
        metalness: 0.035,
        clearcoat: 0.42,
        clearcoatRoughness: 0.5,
        clippingPlanes: [this.clipPlane],
        clipShadows: true,
      });
      const solid = new THREE.Mesh(new THREE.BufferGeometry(), solidMaterial);
      solid.castShadow = true;
      solid.receiveShadow = true;
      solid.renderOrder = 1;

      const connector = new THREE.Mesh(
        new THREE.BufferGeometry(),
        solidMaterial,
      );
      connector.castShadow = false;
      connector.receiveShadow = true;
      connector.visible = false;
      connector.renderOrder = 1;

      const dotMaterial = new THREE.LineBasicMaterial({
        color: ink.clone().offsetHSL(0, 0, 0.035),
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        clippingPlanes: [this.clipPlane],
      });
      const dots = new THREE.LineSegments(new THREE.BufferGeometry(), dotMaterial);
      dots.renderOrder = 3;

      const boundaryMaterial = new THREE.LineBasicMaterial({
        color: ink,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        clippingPlanes: [this.clipPlane],
      });
      const boundary = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        boundaryMaterial,
      );
      boundary.renderOrder = 4;

      const capGroup = new THREE.Group();
      capGroup.visible = false;
      const capMaterial = new THREE.MeshStandardMaterial({
        color: style.colorHex,
        roughness: 0.75,
        metalness: 0,
        emissive: new THREE.Color(style.colorHex).multiplyScalar(0.075),
        side: THREE.DoubleSide,
      });
      const capLineMaterial = new THREE.LineBasicMaterial({
        color: ink,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });

      group.add(solid, connector, dots, boundary, capGroup);
      this.partsRoot.add(group);
      this.partVisuals.push({
        group,
        solid,
        connector,
        dots,
        boundary,
        capGroup,
        capMaterial,
        capLineMaterial,
        capMesh: null,
        capLine: null,
        targetZ: 0,
        explosionRank: index,
      });
    }
  }

  setData(data: ReliefBuildData): void {
    this.data = data;

    for (let index = 0; index < this.partVisuals.length; index += 1) {
      const visual = this.partVisuals[index];
      const part = data.parts[index];
      visual.explosionRank = data.layerOrder.indexOf(index as ColorIndex);

      const solidGeometry = new THREE.BufferGeometry();
      solidGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(part.positions, 3),
      );
      solidGeometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(part.normals, 3),
      );
      solidGeometry.computeBoundingSphere();
      const previousSolid = visual.solid.geometry;
      visual.solid.geometry = solidGeometry;
      disposeGeometry(previousSolid);

      const connectorGeometry = new THREE.BufferGeometry();
      connectorGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(part.connectorPositions, 3),
      );
      connectorGeometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(part.connectorNormals, 3),
      );
      connectorGeometry.computeBoundingSphere();
      const previousConnector = visual.connector.geometry;
      visual.connector.geometry = connectorGeometry;
      disposeGeometry(previousConnector);

      const previousDots = visual.dots.geometry;
      visual.dots.geometry = lineGeometry(part.dotLinePositions);
      disposeGeometry(previousDots);

      const previousBoundary = visual.boundary.geometry;
      visual.boundary.geometry = lineGeometry(part.boundaryLinePositions);
      disposeGeometry(previousBoundary);
    }

    this.sectionBuilt = false;
    if (this.state.mode === 'section' && this.state.selectedParts.length === 0) {
      this.rebuildSectionCaps();
    }
    this.invalidate();
    this.applyState(true);
  }

  updateState(next: Partial<ViewerState>): void {
    const previousMode = this.state.mode;
    const previousSelection = this.state.selectedParts.join(',');
    const previousDistance = this.state.explodeDistance;
    this.state = { ...this.state, ...next };

    if (this.state.mode === 'section' && this.state.selectedParts.length === 0) {
      this.clipPlane.constant = -this.state.sectionY;
    } else {
      this.clipPlane.constant = 10000;
    }

    if (
      this.state.mode !== previousMode ||
      this.state.selectedParts.join(',') !== previousSelection
    ) {
      this.sectionBuilt = false;
    }

    if (this.state.mode === 'section' && this.state.selectedParts.length === 0) {
      this.rebuildSectionCaps();
    }

    const wasExploded = previousMode === 'exploded' && previousSelection === '';
    const isExploded = this.state.mode === 'exploded' && this.state.selectedParts.length === 0;

    if (isExploded && !wasExploded) {
      this.savedExplodePose = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
      };
      this.frameExploded(760);
    } else if (!isExploded && wasExploded) {
      const restore = this.savedExplodePose;
      this.savedExplodePose = null;
      if (restore) {
        this.beginCameraTransition(
          restore.position,
          restore.target,
          620,
        );
      }
    } else if (
      isExploded &&
      wasExploded &&
      previousDistance !== this.state.explodeDistance
    ) {
      this.frameExploded(260);
    }

    this.invalidate();
    this.applyState();
  }

  private frameExploded(duration: number): void {
    const centerZ = this.state.explodeDistance + 11;
    const target = new THREE.Vector3(0, 0, centerZ);
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize();
    if (direction.lengthSq() < 0.1) direction.set(0.53, -0.7, 0.48).normalize();
    const distance = clampNumber(
      195 + this.state.explodeDistance * 2,
      195,
      340,
    );
    const position = target.clone().addScaledVector(direction, distance);
    this.beginCameraTransition(position, target, duration);
  }

  private beginCameraTransition(
    position: THREE.Vector3,
    target: THREE.Vector3,
    duration: number,
  ): void {
    this.cameraTransition = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position.clone(),
      toTarget: target.clone(),
      startedAt: performance.now(),
      duration,
    };
    this.controls.enabled = false;
  }

  updateSection(sectionY: number): void {
    this.invalidate();
    this.state.sectionY = sectionY;
    if (this.state.mode === 'section' && this.state.selectedParts.length === 0) {
      this.clipPlane.constant = -sectionY;
      this.rebuildSectionCaps();
    }
  }

  private rebuildSectionCaps(): void {
    if (!this.data) return;
    const caps = buildSectionCaps(
      this.data.pattern,
      this.state.sectionY,
      this.data.field,
    );

    this.partVisuals.forEach((visual, index) => {
      if (visual.capMesh) {
        visual.capGroup.remove(visual.capMesh);
        disposeGeometry(visual.capMesh.geometry);
        visual.capMesh = null;
      }
      if (visual.capLine) {
        visual.capGroup.remove(visual.capLine);
        disposeGeometry(visual.capLine.geometry);
        visual.capLine = null;
      }

      const source = caps.parts[index];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(source.positions, 3),
      );
      geometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(source.normals, 3),
      );
      geometry.computeBoundingSphere();
      const capMesh = new THREE.Mesh(geometry, visual.capMaterial);
      capMesh.renderOrder = 2;

      const line = new THREE.LineSegments(
        lineGeometry(source.linePositions),
        visual.capLineMaterial,
      );
      line.renderOrder = 5;

      visual.capMesh = capMesh;
      visual.capLine = line;
      visual.capGroup.add(capMesh, line);
    });

    this.sectionBuilt = true;
    this.applyState();
  }

  private applyState(force = false): void {
    const selection = new Set(this.state.selectedParts);
    const hasSelection = selection.size > 0;
    const isExploded = this.state.mode === 'exploded' && !hasSelection;
    const isGhost = this.state.mode === 'xray' && !hasSelection;
    const isSection = this.state.mode === 'section' && !hasSelection;

    if (this.ghostActive !== isGhost || force) {
      this.ghostActive = isGhost;
      for (const visual of this.partVisuals) {
        const material = visual.solid.material;
        material.transparent = isGhost;
        material.depthWrite = !isGhost;
        material.side = isGhost ? THREE.DoubleSide : THREE.FrontSide;
        material.opacity = isGhost ? 0.31 : 1;
        material.needsUpdate = true;
        visual.solid.castShadow = !isGhost;
      }
    }

    this.partVisuals.forEach((visual, index) => {
      const visible = !hasSelection || selection.has(index as ColorIndex);
      visual.group.visible = visible;
      visual.connector.visible = visible;
      visual.targetZ = isExploded
        ? visual.explosionRank * this.state.explodeDistance
        : 0;
      visual.dots.visible = this.state.showDots;
      visual.boundary.visible = this.state.showBoundaries;
      visual.capGroup.visible = isSection && this.sectionBuilt;
    });

    this.controls.autoRotate = this.state.autoRotate;
    this.invalidate();
  }

  private requestFrame(): void {
    if (
      this.disposed ||
      this.frameHandle !== null ||
      document.hidden
    ) {
      return;
    }
    this.frameHandle = window.requestAnimationFrame(this.animate);
  }

  private cancelFrame(): void {
    if (this.frameHandle !== null) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private invalidate(): void {
    this.needsRender = true;
    this.requestFrame();
  }

  private animate = (): void => {
    this.frameHandle = null;
    if (this.disposed || document.hidden) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const easing = 1 - Math.exp(-delta * 8.5);

    for (const visual of this.partVisuals) {
      const difference = visual.targetZ - visual.group.position.z;
      if (Math.abs(difference) > 0.001) {
        visual.group.position.z += difference * easing;
        this.needsRender = true;
        this.requestFrame();
      } else {
        visual.group.position.z = visual.targetZ;
      }
    }

    if (this.cameraTransition) {
      const elapsed = performance.now() - this.cameraTransition.startedAt;
      const t = Math.min(1, elapsed / this.cameraTransition.duration);
      const smooth = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(
        this.cameraTransition.fromPosition,
        this.cameraTransition.toPosition,
        smooth,
      );
      this.controls.target.lerpVectors(
        this.cameraTransition.fromTarget,
        this.cameraTransition.toTarget,
        smooth,
      );
      this.camera.lookAt(this.controls.target);
      this.needsRender = true;
      this.requestFrame();
      if (t >= 1) {
        this.cameraTransition = null;
        this.controls.enabled = true;
        this.controls.update();
      }
    } else {
      const changed = this.controls.update();
      if (changed) {
        this.needsRender = true;
        this.requestFrame();
      }
    }

    if (this.state.autoRotate) {
      this.needsRender = true;
      this.requestFrame();
    }

    if (this.needsRender) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  updatePalette(): void {
    for (let index = 0; index < this.partVisuals.length; index += 1) {
      const visual = this.partVisuals[index];
      const style = PART_STYLES[index];
      visual.solid.material.color.setHex(style.colorHex);
      visual.capMaterial.color.setHex(style.colorHex);
      visual.capMaterial.emissive.setHex(style.colorHex).multiplyScalar(0.075);
    }
    this.invalidate();
  }

  resetCamera(): void {
    this.cameraTransition = null;
    this.controls.enabled = true;
    this.userMovedCamera = false;
    this.camera.position.copy(this.homePosition());
    this.controls.target.copy(CAMERA_TARGET);
    this.controls.update();
    this.invalidate();
  }

  private homePosition(): THREE.Vector3 {
    const width = Math.max(1, this.container.clientWidth);
    const scale = Math.min(1.3, 1 + Math.max(0, 1500 - width) / 1500 * 0.52);
    const direction = CAMERA_HOME.clone().sub(CAMERA_TARGET).normalize();
    return CAMERA_TARGET.clone().addScaledVector(
      direction,
      CAMERA_HOME.distanceTo(CAMERA_TARGET) * scale,
    );
  }

  setCameraPose(
    position: [number, number, number],
    target: [number, number, number] = [0, 0, 11],
  ): void {
    this.userMovedCamera = true;
    this.invalidate();
    this.camera.position.set(...position);
    this.controls.target.set(...target);
    this.controls.update();
  }

  debugInfo(): Record<string, unknown> {
    return {
      camera: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      clipConstant: this.clipPlane.constant,
      render: { ...this.renderer.info.render },
      parts: this.partVisuals.map((visual) => {
        visual.solid.geometry.computeBoundingSphere();
        const sphere = visual.solid.geometry.boundingSphere;
        return {
          visible: visual.group.visible,
          z: visual.group.position.z,
          opacity: visual.solid.material.opacity,
          transparent: visual.solid.material.transparent,
          vertexCount: visual.solid.geometry.getAttribute('position')?.count ?? 0,
          boundingSphere: sphere
            ? { center: sphere.center.toArray(), radius: sphere.radius }
            : null,
        };
      }),
    };
  }

  private scheduleResize(): void {
    if (this.resizeTimeout !== null) window.clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => this.resize(), 30);
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.invalidate();

    if (
      !this.userMovedCamera &&
      !this.cameraTransition &&
      this.state.mode !== 'exploded'
    ) {
      this.camera.position.copy(this.homePosition());
      this.controls.target.copy(CAMERA_TARGET);
      this.controls.update();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame();
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.resizeTimeout !== null) window.clearTimeout(this.resizeTimeout);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const visual of this.partVisuals) {
      disposeGeometry(visual.solid.geometry);
      disposeGeometry(visual.connector.geometry);
      disposeGeometry(visual.dots.geometry);
      disposeGeometry(visual.boundary.geometry);
      disposeGeometry(visual.capMesh?.geometry ?? null);
      disposeGeometry(visual.capLine?.geometry ?? null);
      visual.solid.material.dispose();
      visual.dots.material.dispose();
      visual.boundary.material.dispose();
      visual.capMaterial.dispose();
      visual.capLineMaterial.dispose();
    }
    this.renderer.dispose();
  }
}
